import { mergeTerminalThemeCatalogs } from './shared';
import { POPULAR_DARK_CORE_TERMINAL_THEMES } from './popular-dark-core';
import { POPULAR_DARK_EXTENDED_TERMINAL_THEMES } from './popular-dark-extended';
export const POPULAR_DARK_TERMINAL_THEMES = mergeTerminalThemeCatalogs(POPULAR_DARK_CORE_TERMINAL_THEMES, POPULAR_DARK_EXTENDED_TERMINAL_THEMES);
