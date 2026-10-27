import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { UserStore } from './db.ts';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Two tabs refreshing at once present the same token; tolerate that instead of flagging theft. */
const REUSE_GRACE_MS = 10_000;
export const REFRESH_COOKIE = 'cd_refresh';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(key, expected);
}

/** Verified once at startup so an unknown email costs the same as a wrong password. */
let dummyHash: Promise<string> | null = null;

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export interface AuthUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export interface AuthOptions {
  users: UserStore;
  jwtSecret: Uint8Array;
  allowedOrigins: string[];
  /** Force the Secure cookie flag; otherwise it follows the request protocol. */
  secureCookies?: boolean;
  /** Per-IP limit for register/login (brute-force protection). Default 10/min. */
  credentialRateLimitPerMin?: number;
}

export class Auth {
  constructor(private readonly opts: AuthOptions) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  }

  async issueAccess(user: AuthUser): Promise<string> {
    return new SignJWT({ email: user.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .setIssuer('chartdeck')
      .sign(this.opts.jwtSecret);
  }

  async verifyAccess(token: string): Promise<AuthUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.opts.jwtSecret, { issuer: 'chartdeck', algorithms: ['HS256'] });
      return payload.sub && typeof payload.email === 'string' ? { id: payload.sub, email: payload.email } : null;
    } catch {
      return null;
    }
  }

  /** preHandler that requires a valid bearer token. */
  readonly requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const user = h?.startsWith('Bearer ') ? await this.verifyAccess(h.slice(7)) : null;
    if (!user) return reply.status(401).send({ error: 'unauthorized' });
    req.user = user;
  };

  register(app: FastifyInstance): void {
    const strict = { config: { rateLimit: { max: this.opts.credentialRateLimitPerMin ?? 10, timeWindow: '1 minute' } } };

    app.post('/api/auth/register', strict, async (req, reply) => {
      this.checkOrigin(req);
      const { email, password } = Credentials.parse(req.body);
      const user = await this.opts.users.create(email, await hashPassword(password));
      if (!user) return reply.status(409).send({ error: 'email_taken', message: 'An account with this email already exists' });
      return this.startSession(reply, req, { id: user.id, email: user.email });
    });

    app.post('/api/auth/login', strict, async (req, reply) => {
      this.checkOrigin(req);
      const { email, password } = Credentials.parse(req.body);
      const user = await this.opts.users.byEmail(email);
      const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash!));
      if (!user || !ok) return reply.status(401).send({ error: 'invalid_credentials', message: 'Wrong email or password' });
      return this.startSession(reply, req, { id: user.id, email: user.email });
    });

    app.post('/api/auth/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      this.checkOrigin(req);
      const token = req.cookies[REFRESH_COOKIE];
      if (!token) return reply.status(401).send({ error: 'no_session' });
      const row = await this.opts.users.useRefreshToken(hashToken(token));
      const now = Date.now();
      if (!row || row.revoked_at || row.expires_at.getTime() < now) return this.endSession(reply, 'session_expired');
      if (row.used_at && now - row.used_at.getTime() > REUSE_GRACE_MS) {
        // A rotated-out token came back: assume it was stolen and kill the whole session family.
        req.log.warn({ userId: row.user_id }, 'refresh token reuse detected; revoking session');
        await this.opts.users.revokeFamily(row.family);
        return this.endSession(reply, 'session_revoked');
      }
      const user = await this.opts.users.byId(row.user_id);
      if (!user) return this.endSession(reply, 'session_expired');
      return this.startSession(reply, req, { id: user.id, email: user.email }, row.family);
    });

    app.post('/api/auth/logout', async (req, reply) => {
      this.checkOrigin(req);
      const token = req.cookies[REFRESH_COOKIE];
      const family = token ? await this.opts.users.familyOf(hashToken(token)) : null;
      if (family) await this.opts.users.revokeFamily(family);
      this.clearCookie(reply);
      return { ok: true };
    });

    app.get('/api/auth/me', { preHandler: this.requireUser }, async (req) => ({ user: req.user }));
  }

  private async startSession(reply: FastifyReply, req: FastifyRequest, user: AuthUser, family: string = randomUUID()) {
    const refresh = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + REFRESH_TTL_MS);
    await this.opts.users.addRefreshToken(user.id, family, hashToken(refresh), expires);
    reply.setCookie(REFRESH_COOKIE, refresh, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.opts.secureCookies ?? req.protocol === 'https',
      path: '/api/auth',
      expires,
    });
    return { user, accessToken: await this.issueAccess(user), expiresIn: ACCESS_TTL_SEC };
  }

  private endSession(reply: FastifyReply, code: string) {
    this.clearCookie(reply);
    return reply.status(401).send({ error: code });
  }

  private clearCookie(reply: FastifyReply) {
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  /** Cookie-authenticated endpoints only accept same-site browser requests. */
  private checkOrigin(req: FastifyRequest): void {
    const origin = req.headers.origin;
    const { allowedOrigins } = this.opts;
    if (origin && !allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) {
      throw Object.assign(new Error('Origin not allowed'), { statusCode: 403 });
    }
  }
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
