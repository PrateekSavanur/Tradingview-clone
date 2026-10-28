import { create } from 'zustand';

export interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: 'info' | 'success' | 'error' | 'alert';
  /** Primary action, e.g. "Show chart". */
  action?: { label: string; run(): void };
}

interface ToastState {
  toasts: Toast[];
  push(t: Omit<Toast, 'id'>, ttlMs?: number): void;
  dismiss(id: number): void;
}

let seq = 0;
const MAX_TOASTS = 5;

export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (t, ttlMs = t.tone === 'alert' ? 20_000 : 6_000) => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-MAX_TOASTS) }));
    if (ttlMs > 0) window.setTimeout(() => get().dismiss(id), ttlMs);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = (t: Omit<Toast, 'id'>, ttlMs?: number) => useToasts.getState().push(t, ttlMs);
