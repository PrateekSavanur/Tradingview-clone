import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * SMTP when `SMTP_URL` is set (e.g. smtp://user:pass@host:587, or smtp://localhost:1025 for
 * Mailpit in development); otherwise messages are only logged, links included, which is fine
 * locally and makes a missing config obvious elsewhere.
 */
export function mailerFromEnv(log: Logger): Mailer {
  const url = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM || 'ChartDeck <no-reply@chartdeck.local>';
  if (!url) {
    log.warn('SMTP_URL not set; emails are written to the log instead of being sent');
    return {
      async send(mail) {
        log.info({ mail }, 'email (not sent: SMTP_URL unset)');
      },
    };
  }
  const transport: Transporter = nodemailer.createTransport(url);
  return {
    async send(mail) {
      await transport.sendMail({ from, ...mail });
    },
  };
}
