export type TerminalShortcutEvent = {
    key: string;
    code?: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat?: boolean;
};
export type MacOptionAsAlt = 'true' | 'false' | 'left' | 'right';
export type TerminalShortcutAction = {
    type: 'copySelection';
} | {
    type: 'toggleSearch';
} | {
    type: 'clearActivePane';
} | {
    type: 'focusPane';
    direction: 'next' | 'previous';
} | {
    type: 'toggleExpandActivePane';
} | {
    type: 'closeActivePane';
} | {
    type: 'splitActivePane';
    direction: 'vertical' | 'horizontal';
} | {
    type: 'sendInput';
    data: string;
};
export declare function resolveTerminalShortcutAction(event: TerminalShortcutEvent, isMac: boolean, macOptionAsAlt?: MacOptionAsAlt, optionKeyLocation?: number): TerminalShortcutAction | null;
