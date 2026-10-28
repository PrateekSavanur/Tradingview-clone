import { INDICATOR_BY_ID, defaultInputs } from '@chartdeck/indicators';
import type { IndicatorInstanceDoc } from '@chartdeck/shared';
import { create } from 'zustand';
import { newUid } from '../workspace/model.ts';

export type IndicatorInstance = IndicatorInstanceDoc;
export type PlotStyle = IndicatorInstance['plots'][string];

export const MAX_INDICATORS = 20;

export function newInstance(type: string): IndicatorInstance | null {
  const meta = INDICATOR_BY_ID.get(type);
  if (!meta) return null;
  return {
    uid: newUid(),
    type,
    inputs: defaultInputs(meta),
    plots: Object.fromEntries(meta.plots.map((p) => [p.key, { color: p.color, width: p.width ?? 2, visible: !p.hidden }])),
    hidden: false,
  };
}

/**
 * Indicator dialogs. The instances themselves belong to each chart in the workspace store;
 * a chart's indicators apply to every symbol it shows, the way a chart template behaves.
 */
interface IndicatorUiState {
  pickerOpen: boolean;
  /** The instance whose settings dialog is open. */
  editing: { chart: number; uid: string } | null;
  openPicker(open: boolean): void;
  edit(target: { chart: number; uid: string } | null): void;
}

export const useIndicators = create<IndicatorUiState>()((set) => ({
  pickerOpen: false,
  editing: null,
  openPicker: (pickerOpen) => set({ pickerOpen }),
  edit: (editing) => set({ editing }),
}));
