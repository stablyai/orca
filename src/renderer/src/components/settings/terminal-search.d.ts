import type { SettingsSearchEntry } from './settings-search';
export declare const TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_CURSOR_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_PANE_STYLE_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_DARK_THEME_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_LIGHT_THEME_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_ADVANCED_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_MAC_OPTION_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_SETUP_SCRIPT_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_WINDOWS_SEARCH_ENTRIES: SettingsSearchEntry[];
export declare const TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY: SettingsSearchEntry[];
export declare function getTerminalPaneSearchEntries(platform: {
    isWindows: boolean;
    isMac: boolean;
}): SettingsSearchEntry[];
