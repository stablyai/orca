import { TERMINAL_THEME_CATALOG } from './terminal-themes';
export const TERMINAL_THEMES = TERMINAL_THEME_CATALOG;
export function getThemeNames() {
    return Object.keys(TERMINAL_THEMES).sort();
}
export function getTheme(name) {
    return TERMINAL_THEMES[name] ?? null;
}
