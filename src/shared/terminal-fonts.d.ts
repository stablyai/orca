export declare const DEFAULT_TERMINAL_FONT_WEIGHT = 500;
export declare const TERMINAL_FONT_WEIGHT_MIN = 100;
export declare const TERMINAL_FONT_WEIGHT_MAX = 900;
export declare const TERMINAL_FONT_WEIGHT_STEP = 100;
export declare const DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 700;
export declare function normalizeTerminalFontWeight(fontWeight: number | null | undefined): number;
export declare function resolveTerminalFontWeights(fontWeight: number | null | undefined): {
    fontWeight: number;
    fontWeightBold: number;
};
