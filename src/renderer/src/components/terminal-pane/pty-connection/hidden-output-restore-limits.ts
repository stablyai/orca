export const HIDDEN_OUTPUT_RESTORE_PENDING_CHARS = 512 * 1024
export const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS = 50
export const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX = 3
export const HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS = 750
// Why (rc.7.perf DSR-timeout feedback loop): under a foreground flood the
// restore pipeline is its own bottleneck — each synchronous snapshot replay
// starves ACK processing, main pins at the in-flight cap, drops at the
// pending cap, and every drop marker re-armed another restore until the
// flood ended. Backpressure evidence opens this suppression window: drop
// markers inside it must not re-arm restores; live bytes write through and
// ONE deferred repaint (when the window closes) heals the visual gap.
export const HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS = 2000
// Backstop for the same loop: a single in-flight restore task may re-iterate
// (fresh-snapshot marks, unmappable slices) only this many times before it
// abandons and lets live bytes flow.
export const HIDDEN_OUTPUT_RESTORE_MAX_LOOP_ITERATIONS = 3
// Why: remote-runtime PTYs have no local main fallback — the host transport is
// the only recovery and legitimately answers null while it resyncs, trims a
// flooded snapshot, or waits out link RTT. Those nulls are not proof of loss,
// so an abandoned restore re-arms one quiet post-suppression repaint instead of
// claiming the bytes are gone. Five cycles (~2.15s each) outlast both the
// multiplexer resync window and the remote snapshot request timeout (10s);
// past that the host really is unreachable and the loss banner is honest.
export const HIDDEN_OUTPUT_RESTORE_REMOTE_REARM_MAX = 5
// Why: the host declined seven separate times; each one cost it a real serialize attempt, so stop asking.
export const HIDDEN_OUTPUT_RESTORE_REMOTE_OUTCOME_MAX_ATTEMPTS = 7
// Why separate and larger: these causes are decided before any frame leaves the
// client (resync gate, occupied request lane, detached stream), so the host
// declined nothing and charging them to its budget would banner a healthy pane —
// the exact elapsed-time guess this change removes. They cost zero host traffic,
// so the only job of this cap is termination. At the ~2s post-abandon re-arm
// cadence, 30 outlasts several full 10s resync watchdog cycles.
export const HIDDEN_OUTPUT_RESTORE_LOCAL_GATE_MAX_ATTEMPTS = 30
// Why: this is only shown if hidden renderer output was skipped and main-owned
// terminal state is unavailable, so the user has an explicit loss signal.
export const HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING =
  '\r\n[Orca skipped hidden terminal output because main recovery was unavailable.]\r\n'
