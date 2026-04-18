/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export declare function useNotificationDispatch(worktreeId: string): (event: {
    source: 'agent-task-complete' | 'terminal-bell';
    terminalTitle?: string;
}) => void;
