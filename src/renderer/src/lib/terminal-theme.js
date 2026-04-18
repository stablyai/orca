import { getTheme, getThemeNames } from './terminal-themes-data';
export const BUILTIN_TERMINAL_THEME_NAMES = getThemeNames();
export const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark';
export const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light';
export const DEFAULT_TERMINAL_DIVIDER_DARK = '#3f3f46';
export const DEFAULT_TERMINAL_DIVIDER_LIGHT = '#d4d4d8';
export function getSystemPrefersDark() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return true;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}
export function getBuiltinTheme(name) {
    return getTheme(name);
}
export function getTerminalThemePreview(name) {
    const theme = getTheme(name);
    if (theme) {
        return theme;
    }
    return getTheme(DEFAULT_TERMINAL_THEME_DARK);
}
export function resolveEffectiveTerminalAppearance(settings, systemPrefersDark = getSystemPrefersDark()) {
    const sourceTheme = settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme;
    const useLightVariant = sourceTheme === 'light' && settings.terminalUseSeparateLightTheme;
    const themeName = useLightVariant
        ? settings.terminalThemeLight || DEFAULT_TERMINAL_THEME_LIGHT
        : settings.terminalThemeDark || DEFAULT_TERMINAL_THEME_DARK;
    const dividerColor = useLightVariant
        ? normalizeColor(settings.terminalDividerColorLight, DEFAULT_TERMINAL_DIVIDER_LIGHT)
        : normalizeColor(settings.terminalDividerColorDark, DEFAULT_TERMINAL_DIVIDER_DARK);
    return {
        mode: sourceTheme,
        sourceTheme: settings.theme,
        themeName,
        dividerColor,
        theme: getTerminalThemePreview(themeName),
        systemPrefersDark
    };
}
export function normalizeColor(value, fallback) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return fallback;
    }
    return trimmed;
}
export function buildTerminalFontMatchers(fontFamily) {
    const trimmed = fontFamily.trim();
    const normalized = trimmed.toLowerCase();
    const matchers = trimmed ? [trimmed, normalized] : [];
    return Array.from(new Set([
        ...matchers,
        'sf mono',
        'sfmono-regular',
        'menlo',
        'menlo regular',
        'dejavu sans mono',
        'liberation mono',
        'ubuntu mono',
        'monospace'
    ]));
}
export function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function resolvePaneStyleOptions(settings) {
    return {
        inactivePaneOpacity: clampNumber(settings.terminalInactivePaneOpacity, 0, 1),
        activePaneOpacity: clampNumber(settings.terminalActivePaneOpacity, 0, 1),
        opacityTransitionMs: clampNumber(settings.terminalPaneOpacityTransitionMs, 0, 5000),
        dividerThicknessPx: clampNumber(settings.terminalDividerThicknessPx, 1, 32),
        // Why no clamping: boolean pass-through. Both true and false are valid.
        focusFollowsMouse: settings.terminalFocusFollowsMouse
    };
}
export function getCursorStyleSequence(style, blinking) {
    const code = style === 'block'
        ? blinking
            ? 1
            : 2
        : style === 'underline'
            ? blinking
                ? 3
                : 4
            : blinking
                ? 5
                : 6;
    return `\u001b[${code} q`;
}
export function colorToCss(color, fallback) {
    if (!color) {
        return fallback;
    }
    if (typeof color === 'string') {
        return color;
    }
    const alpha = typeof color.a === 'number' ? color.a / 255 : 1;
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}
const PALETTE_KEYS = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite'
];
export function terminalPalettePreview(theme) {
    if (!theme) {
        return [];
    }
    const swatches = [];
    for (const key of PALETTE_KEYS) {
        const color = theme[key];
        if (color) {
            swatches.push(color);
        }
    }
    return swatches;
}
