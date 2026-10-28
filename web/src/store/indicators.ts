import { INDICATOR_BY_ID, defaultInputs } from '@chartdeck/indicators';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlotStyle {
  color: string;
  width: number;
  visible: boolean;
}

export interface IndicatorInstance {
  uid: string;
  type: string;
  inputs: Record<string, number | string>;
  plots: Record<string, PlotStyle>;
  hidden: boolean;
}

interface IndicatorState {
  list: IndicatorInstance[];
  pickerOpen: boolean;
  /** uid of the instance whose settings dialog is open. */
  editing: string | null;
  add(type: string): void;
  remove(uid: string): void;
  update(uid: string, patch: Partial<Pick<IndicatorInstance, 'inputs' | 'plots' | 'hidden'>>): void;
  openPicker(open: boolean): void;
  edit(uid: string | null): void;
}

export const MAX_INDICATORS = 20;

export function newInstance(type: string): IndicatorInstance | null {
  const meta = INDICATOR_BY_ID.get(type);
  if (!meta) return null;
  return {
    uid: crypto.randomUUID().slice(0, 8),
    type,
    inputs: defaultInputs(meta),
    plots: Object.fromEntries(meta.plots.map((p) => [p.key, { color: p.color, width: p.width ?? 2, visible: !p.hidden }])),
    hidden: false,
  };
}

/** Indicators apply to every symbol, the way traders expect a chart template to behave. */
export const useIndicators = create<IndicatorState>()(
  persist(
    (set) => ({
      list: [],
      pickerOpen: false,
      editing: null,
      add: (type) =>
        set((s) => {
          const inst = newInstance(type);
          return inst && s.list.length < MAX_INDICATORS ? { list: [...s.list, inst] } : s;
        }),
      remove: (uid) => set((s) => ({ list: s.list.filter((i) => i.uid !== uid), editing: s.editing === uid ? null : s.editing })),
      update: (uid, patch) => set((s) => ({ list: s.list.map((i) => (i.uid === uid ? { ...i, ...patch } : i)) })),
      openPicker: (pickerOpen) => set({ pickerOpen }),
      edit: (editing) => set({ editing }),
    }),
    {
      name: 'chartdeck-indicators',
      partialize: (s) => ({ list: s.list.filter((i) => INDICATOR_BY_ID.has(i.type)) }),
    },
  ),
);
