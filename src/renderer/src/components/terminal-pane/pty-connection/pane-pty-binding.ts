import type { IDisposable } from '@xterm/xterm'
import type { HasPty } from '../terminal-dead-session-reconcile'

export type PanePtyBinding = IDisposable & {
  syncProcessTracking: () => void
  noteVisibilityResume: () => void
  reassertPtySizeAfterWindowWake: () => void
  /** Navigation-free hibernation wake: fires the armed cold-restore --resume
   *  without the size-reassert/foreground-sample side effects of a real reveal.
   *  Used by the mobile wake fanout so a hidden hibernated pane resumes with no
   *  desktop hidden→visible transition. Returns the sleeping record's provider
   *  session claim key when this pane started (or latched) the in-place wake,
   *  so the follow-up generic resume never launches the same session twice. */
  wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
  /** Re-sample process identity when the pane gains intra-tab focus: the tab
   *  icon follows the active leaf, and a shell-marked entry on a still-running
   *  agent pane has no OSC boundary left to correct it. */
  sampleForegroundAgentOnFocus: () => void
  /** Reconfirm after direct shortcut input, which bypasses PTY onData. */
  requestWindowsShiftEnterReconfirmation: () => void
  /** Refresh interactive redraw scheduling after captured shortcut input. */
  markShortcutTerminalInputSent: () => void
  reconcileIfSessionDead: (liveSessionIds: Set<string>, snapshotRequestedAt?: number) => void
  reconcileIfSessionMissing: (hasPty: HasPty, livenessRequestedAt?: number) => void
}
