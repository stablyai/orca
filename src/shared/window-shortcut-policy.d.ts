export type WindowShortcutInput = {
    key?: string;
    code?: string;
    alt?: boolean;
    meta?: boolean;
    control?: boolean;
    shift?: boolean;
};
export type WindowShortcutAction = {
    type: 'zoom';
    direction: 'in' | 'out' | 'reset';
} | {
    type: 'toggleWorktreePalette';
} | {
    type: 'toggleLeftSidebar';
} | {
    type: 'toggleRightSidebar';
} | {
    type: 'openQuickOpen';
} | {
    type: 'jumpToWorktreeIndex';
    index: number;
};
export declare function isWindowShortcutModifierChord(input: Pick<WindowShortcutInput, 'meta' | 'control' | 'alt'>, platform: NodeJS.Platform): boolean;
export declare function resolveWindowShortcutAction(input: WindowShortcutInput, platform: NodeJS.Platform): WindowShortcutAction | null;
