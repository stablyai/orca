import { CLASSIC_TERMINAL_THEMES } from './classic';
import { DEFAULT_TERMINAL_THEMES } from './defaults';
import { POPULAR_DARK_TERMINAL_THEMES } from './popular-dark';
import { POPULAR_LIGHT_TERMINAL_THEMES } from './popular-light';
import { mergeTerminalThemeCatalogs } from './shared';
const THEME_CATEGORIES = [
    DEFAULT_TERMINAL_THEMES,
    POPULAR_DARK_TERMINAL_THEMES,
    POPULAR_LIGHT_TERMINAL_THEMES,
    CLASSIC_TERMINAL_THEMES
];
export const TERMINAL_THEME_CATALOG = mergeTerminalThemeCatalogs(...THEME_CATEGORIES);
