// ── Singleton PTY event dispatcher ───────────────────────────────────
// One global IPC listener per channel, routes events to transports by
// PTY ID. Eliminates the N-listener problem that triggers
// MaxListenersExceededWarning with many panes/tabs.
export const ptyDataHandlers = new Map();
export const ptyExitHandlers = new Map();
export const openCodeStatusHandlers = new Map();
/** Per-PTY teardown callbacks registered by each transport to clear closure
 *  state (stale-title timer, agent tracker) that would otherwise fire after
 *  the data handler is removed. */
export const ptyTeardownHandlers = new Map();
let ptyDispatcherAttached = false;
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
export function unregisterPtyDataHandlers(ptyIds) {
    for (const id of ptyIds) {
        ptyDataHandlers.delete(id);
        openCodeStatusHandlers.delete(id);
        ptyTeardownHandlers.get(id)?.();
        ptyTeardownHandlers.delete(id);
    }
}
export function ensurePtyDispatcher() {
    if (ptyDispatcherAttached) {
        return;
    }
    ptyDispatcherAttached = true;
    window.api.pty.onData((payload) => {
        ptyDataHandlers.get(payload.id)?.(payload.data);
    });
    window.api.pty.onExit((payload) => {
        ptyExitHandlers.get(payload.id)?.(payload.code);
    });
    window.api.pty.onOpenCodeStatus((payload) => {
        openCodeStatusHandlers.get(payload.ptyId)?.(payload);
    });
}
const eagerPtyHandles = new Map();
export function getEagerPtyBufferHandle(ptyId) {
    return eagerPtyHandles.get(ptyId);
}
// Why: 512 KB matches the scrollback buffer cap used by TerminalPane's
// serialization. Prevents unbounded memory growth if a restored shell
// runs a long-lived command (e.g. tail -f) in a worktree the user never opens.
const EAGER_BUFFER_MAX_BYTES = 512 * 1024;
export function registerEagerPtyBuffer(ptyId, onExit) {
    ensurePtyDispatcher();
    const buffer = [];
    let bufferBytes = 0;
    const dataHandler = (data) => {
        buffer.push(data);
        bufferBytes += data.length;
        // Trim from the front when the buffer exceeds the cap, keeping the
        // most recent output which contains the shell prompt.
        while (bufferBytes > EAGER_BUFFER_MAX_BYTES && buffer.length > 1) {
            bufferBytes -= buffer.shift().length;
        }
    };
    const exitHandler = (code) => {
        // Shell died before TerminalPane attached — clean up and notify the store
        // so the tab's ptyId is cleared and connectPanePty falls through to connect().
        ptyDataHandlers.delete(ptyId);
        ptyExitHandlers.delete(ptyId);
        eagerPtyHandles.delete(ptyId);
        onExit(ptyId, code);
    };
    ptyDataHandlers.set(ptyId, dataHandler);
    ptyExitHandlers.set(ptyId, exitHandler);
    const handle = {
        flush() {
            const data = buffer.join('');
            buffer.length = 0;
            return data;
        },
        dispose() {
            // Only remove if the current handler is still the temp one (compare by
            // reference). After attach() replaces the handler this becomes a no-op.
            if (ptyDataHandlers.get(ptyId) === dataHandler) {
                ptyDataHandlers.delete(ptyId);
            }
            if (ptyExitHandlers.get(ptyId) === exitHandler) {
                ptyExitHandlers.delete(ptyId);
            }
            eagerPtyHandles.delete(ptyId);
        }
    };
    eagerPtyHandles.set(ptyId, handle);
    return handle;
}
