import type { ITheme } from '@xterm/xterm';
import type { GlobalSettings } from '../../../shared/types';
export declare const BUILTIN_TERMINAL_THEME_NAMES: string[];
export declare const DEFAULT_TERMINAL_THEME_DARK = "Ghostty Default Style Dark";
export declare const DEFAULT_TERMINAL_THEME_LIGHT = "Builtin Tango Light";
export declare const DEFAULT_TERMINAL_DIVIDER_DARK = "#3f3f46";
export declare const DEFAULT_TERMINAL_DIVIDER_LIGHT = "#d4d4d8";
export type EffectiveTerminalAppearance = {
    mode: 'dark' | 'light';
    sourceTheme: 'system' | 'dark' | 'light';
    themeName: string;
    dividerColor: string;
    theme: ITheme | null;
    systemPrefersDark: boolean;
};
export declare function getSystemPrefersDark(): boolean;
export declare function getBuiltinTheme(name: string): ITheme | null;
export declare function getTerminalThemePreview(name: string): ITheme | null;
export declare function resolveEffectiveTerminalAppearance(settings: Pick<GlobalSettings, 'theme' | 'terminalThemeDark' | 'terminalDividerColorDark' | 'terminalUseSeparateLightTheme' | 'terminalThemeLight' | 'terminalDividerColorLight'>, systemPrefersDark?: boolean): EffectiveTerminalAppearance;
export declare function normalizeColor(value: string | undefined, fallback: string): string;
export declare function buildTerminalFontMatchers(fontFamily: string): string[];
export declare function clampNumber(value: number, min: number, max: number): number;
export declare function resolvePaneStyleOptions(settings: Pick<GlobalSettings, 'terminalInactivePaneOpacity' | 'terminalActivePaneOpacity' | 'terminalPaneOpacityTransitionMs' | 'terminalDividerThicknessPx' | 'terminalFocusFollowsMouse'>): {
    inactivePaneOpacity: number;
    activePaneOpacity: number;
    opacityTransitionMs: number;
    dividerThicknessPx: number;
    focusFollowsMouse: boolean;
};
export declare function getCursorStyleSequence(style: 'bar' | 'block' | 'underline', blinking: boolean): string;
export declare function colorToCss(color: {
    r: number;
    g: number;
    b: number;
    a?: number;
} | string | undefined, fallback: string): string;
export declare function terminalPalettePreview(theme: ITheme | null): string[];
