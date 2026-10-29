import type { IDisposable } from '@xterm/xterm'
import type { HasPty } from '../terminal-dead-session-reconcile'

export type PanePtyBinding = IDisposable & {
  syncProcessTracking: () => void
  noteVisibilityResume: () => void
  reassertPtySizeAfterWindowWake: () => void
  /** Mobile wake resumes hidden panes without reveal’s size/process reads; return the provider-session claim for started or latched wakes to prevent generic duplicate resume. */
  wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
  /** Focus changes resample active-leaf identity because a live agent with stale shell state may emit no correcting command boundary. */
  sampleForegroundAgentOnFocus: () => void
  /** Reconfirm after direct shortcut input, which bypasses PTY onData. */
  requestWindowsShiftEnterReconfirmation: () => void
  /** Refresh interactive redraw scheduling after captured shortcut input. */
  markShortcutTerminalInputSent: () => void
  reconcileIfSessionMissing: (hasPty: HasPty, livenessRequestedAt?: number) => void
  /** Fresh-spawned, never-typed PTYs qualify for newborn failure diagnostics; read at unmount so parked owners retain a value without holding the session. */
  isUntouchedFreshSpawnPty: (ptyId: string) => boolean
}
