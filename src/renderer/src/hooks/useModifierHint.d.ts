export declare const CLEAR_MODIFIER_HINTS_EVENT = "orca:clear-modifier-hints";
type ModifierHintKeyboardEvent = Pick<KeyboardEvent, 'key' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'repeat'>;
export declare function dispatchClearModifierHints(): void;
export declare function shouldStartModifierHintTimer(e: ModifierHintKeyboardEvent): boolean;
export declare function shouldClearModifierHintOnKeyUp(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey'>): boolean;
/**
 * Tracks whether the user is holding the platform modifier key (Cmd on Mac,
 * Ctrl on Linux/Windows) long enough to show number-hint badges on worktree
 * cards.
 *
 * Rules:
 * - Timer starts on modifier keydown (alone, no other modifiers pressed).
 * - After 750 ms of uninterrupted hold, `showHints` becomes true.
 * - Any other key pressed while the modifier is held cancels the timer —
 *   the user is executing a shortcut, not looking for help.
 * - Hints vanish instantly on keyup (no fade-out delay).
 * - Window blur resets state to handle Cmd+Tab away without a keyup event.
 * - `e.repeat` events are ignored so the timer only starts once.
 */
export declare function useModifierHint(enabled?: boolean): {
    showHints: boolean;
};
export {};
