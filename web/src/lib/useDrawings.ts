import { useEffect, useState } from 'react';
import type { ChartController } from '../chart/ChartController.ts';
import type { DrawingUiState } from '../drawings/DrawingManager.ts';

export function useDrawings(controller: ChartController | null): DrawingUiState | null {
  const [state, setState] = useState<DrawingUiState | null>(null);
  useEffect(() => controller?.drawings.onState(setState), [controller]);
  return state;
}
