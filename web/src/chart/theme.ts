import type { Theme } from '../store/ui.ts';

export interface ChartPalette {
  bg: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  up: string;
  down: string;
  upVolume: string;
  downVolume: string;
  line: string;
  areaTop: string;
  areaBottom: string;
}

export const PALETTES: Record<Theme, ChartPalette> = {
  dark: {
    bg: '#131722', text: '#d1d4dc', grid: 'rgba(42, 46, 57, 0.6)', border: '#2a2e39', crosshair: '#758696',
    up: '#089981', down: '#f23645', upVolume: 'rgba(8, 153, 129, 0.5)', downVolume: 'rgba(242, 54, 69, 0.5)',
    line: '#2962ff', areaTop: 'rgba(41, 98, 255, 0.28)', areaBottom: 'rgba(41, 98, 255, 0.02)',
  },
  light: {
    bg: '#ffffff', text: '#131722', grid: 'rgba(240, 243, 250, 1)', border: '#e0e3eb', crosshair: '#9598a1',
    up: '#089981', down: '#f23645', upVolume: 'rgba(8, 153, 129, 0.45)', downVolume: 'rgba(242, 54, 69, 0.45)',
    line: '#2962ff', areaTop: 'rgba(41, 98, 255, 0.22)', areaBottom: 'rgba(41, 98, 255, 0.02)',
  },
};
