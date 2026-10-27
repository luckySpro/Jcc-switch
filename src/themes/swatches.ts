/**
 * 色卡：在 html 上设置 data-swatch，由 swatches.css 覆盖设计 token。
 * 选择只关乎本机外观，存在 localStorage。
 */
import "./swatches.css";

export type SwatchId =
  | "clay"
  | "graphite"
  | "celadon"
  | "indigo"
  | "rose"
  | "original";

export interface Swatch {
  id: SwatchId;
  nameKey: string;
  defaultName: string;
  /** 预览色：背景、强调、文字 */
  light: [string, string, string];
  dark: [string, string, string];
}

export const DEFAULT_SWATCH: SwatchId = "clay";
const STORAGE_KEY = "jcc-switch-swatch";

export const SWATCHES: Swatch[] = [
  {
    id: "clay",
    nameKey: "settings.swatch.clay",
    defaultName: "陶土",
    light: ["#FAF9F5", "#C96442", "#262624"],
    dark: ["#262624", "#C96442", "#ECE9E1"],
  },
  {
    id: "graphite",
    nameKey: "settings.swatch.graphite",
    defaultName: "石墨",
    light: ["#F7F7F5", "#2F2F2D", "#1F1F1E"],
    dark: ["#1C1C1B", "#E6E6E1", "#EDEDEA"],
  },
  {
    id: "celadon",
    nameKey: "settings.swatch.celadon",
    defaultName: "青瓷",
    light: ["#F4F7F4", "#2F7D6D", "#1F2A26"],
    dark: ["#1D2422", "#3E8E7E", "#E6EEEA"],
  },
  {
    id: "indigo",
    nameKey: "settings.swatch.indigo",
    defaultName: "靛蓝",
    light: ["#F6F6FB", "#4F5FC0", "#1F2033"],
    dark: ["#1E1F2A", "#5B6CC9", "#E8E9F3"],
  },
  {
    id: "rose",
    nameKey: "settings.swatch.rose",
    defaultName: "绯红",
    light: ["#FBF6F6", "#B44A5F", "#2C2022"],
    dark: ["#2A1F21", "#C2566B", "#F1E6E7"],
  },
  {
    id: "original",
    nameKey: "settings.swatch.original",
    defaultName: "上游原版",
    light: ["#FFFFFF", "#F97316", "#18181B"],
    dark: ["#1C1C1E", "#EA580C", "#E4E4E7"],
  },
];

export function getStoredSwatch(): SwatchId {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value && SWATCHES.some((s) => s.id === value)) return value as SwatchId;
  } catch {
    // 存储不可用时用默认
  }
  return DEFAULT_SWATCH;
}

export function applySwatch(id: SwatchId) {
  const root = document.documentElement;
  if (id === "original") {
    delete root.dataset.swatch;
  } else {
    root.dataset.swatch = id;
  }
}

export function setSwatch(id: SwatchId) {
  applySwatch(id);
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 忽略
  }
}
