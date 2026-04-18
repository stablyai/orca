/**
 * Singleton PTY event dispatcher and eager buffer helpers.
 *
 * Why extracted: keeps pty-transport.ts under the 300-line limit while
 * co-locating the global handler maps that both the transport factory
 * and the eager-buffer reconnection logic share.
 */
import type { OpenCodeStatusEvent } from '../../../../shared/types';
export declare const ptyDataHandlers: Map<string, (data: string) => void>;
export declare const ptyExitHandlers: Map<string, (code: number) => void>;
export declare const openCodeStatusHandlers: Map<string, (event: OpenCodeStatusEvent) => void>;
/** Per-PTY teardown callbacks registered by each transport to clear closure
 *  state (stale-title timer, agent tracker) that would otherwise fire after
 *  the data handler is removed. */
export declare const ptyTeardownHandlers: Map<string, () => void>;
/**
 * Remove data and status handlers for the given PTY IDs so that any final
 * data flushed by the main process during PTY teardown cannot trigger
 * bell / agent-status notifications from a worktree that is being shut down.
 * Also invokes per-transport teardown callbacks to cancel accumulated closure
 * state (e.g. staleTitleTimer, agent tracker) that could independently fire
 * stale notifications.
 * Exit handlers are intentionally kept alive so the normal exit-cleanup
 * path (unregister, clear stale timers, update store) still runs.
 */
export declare function unregisterPtyDataHandlers(ptyIds: string[]): void;
export declare function ensurePtyDispatcher(): void;
export type EagerPtyHandle = {
    flush: () => string;
    dispose: () => void;
};
export declare function getEagerPtyBufferHandle(ptyId: string): EagerPtyHandle | undefined;
export declare function registerEagerPtyBuffer(ptyId: string, onExit: (ptyId: string, code: number) => void): EagerPtyHandle;
export type PtyConnectResult = {
    id: string;
    snapshot?: string;
    snapshotCols?: number;
    snapshotRows?: number;
    isAlternateScreen?: boolean;
    coldRestore?: {
        scrollback: string;
        cwd: string;
    };
};
export type PtyTransport = {
    connect: (options: {
        url: string;
        cols?: number;
        rows?: number;
        /** Daemon session ID for reattach. When provided, the daemon reconnects
         *  to an existing session instead of creating a new one. */
        sessionId?: string;
        callbacks: {
            onConnect?: () => void;
            onDisconnect?: () => void;
            onData?: (data: string) => void;
            onStatus?: (shell: string) => void;
            onError?: (message: string, errors?: string[]) => void;
            onExit?: (code: number) => void;
        };
    }) => void | Promise<void | string | PtyConnectResult>;
    /** Attach to an existing PTY that was eagerly spawned during startup.
     *  Skips pty:spawn — registers handlers and replays buffered data instead. */
    attach: (options: {
        existingPtyId: string;
        cols?: number;
        rows?: number;
        /** When true, the session uses the alternate screen buffer (e.g., Codex).
         *  Skips the delayed double-resize since a single resize already triggers
         *  a full TUI repaint without content loss. */
        isAlternateScreen?: boolean;
        callbacks: {
            onConnect?: () => void;
            onDisconnect?: () => void;
            onData?: (data: string) => void;
            onStatus?: (shell: string) => void;
            onError?: (message: string, errors?: string[]) => void;
            onExit?: (code: number) => void;
        };
    }) => void;
    disconnect: () => void;
    sendInput: (data: string) => boolean;
    resize: (cols: number, rows: number, meta?: {
        widthPx?: number;
        heightPx?: number;
        cellW?: number;
        cellH?: number;
    }) => boolean;
    isConnected: () => boolean;
    getPtyId: () => string | null;
    preserve?: () => void;
    /** Unregister PTY handlers without killing the process, so a remounted
     *  pane can reattach to the same running shell. */
    detach?: () => void;
    destroy?: () => void | Promise<void>;
};
export type IpcPtyTransportOptions = {
    cwd?: string;
    env?: Record<string, string>;
    command?: string;
    connectionId?: string | null;
    /** Orca worktree identity for scoped shell history. */
    worktreeId?: string;
    onPtyExit?: (ptyId: string) => void;
    onTitleChange?: (title: string, rawTitle: string) => void;
    onPtySpawn?: (ptyId: string) => void;
    onBell?: () => void;
    onAgentBecameIdle?: (title: string) => void;
    onAgentBecameWorking?: () => void;
    onAgentExited?: () => void;
};
