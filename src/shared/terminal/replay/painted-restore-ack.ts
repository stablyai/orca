/** The pane a view painted a cold restore into; main releases the restore only for its current terminal. */
export type PaintedRestorePane = { worktreeId: string; tabId: string; leafId: string }

/** `pty:ackColdRestore`'s payload. `pane` is sent only by layout-owner builds. */
export type PaintedRestoreAck = { id: string; pane?: PaintedRestorePane }
