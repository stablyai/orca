export declare const TOGGLE_TERMINAL_PANE_EXPAND_EVENT = "orca-toggle-terminal-pane-expand";
export declare const FOCUS_TERMINAL_PANE_EVENT = "orca-focus-terminal-pane";
export type ToggleTerminalPaneExpandDetail = {
    tabId: string;
};
export type FocusTerminalPaneDetail = {
    tabId: string;
    paneId: number;
};
