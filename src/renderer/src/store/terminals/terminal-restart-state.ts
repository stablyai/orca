import type { AccountRestartAgent } from './terminal-contracts'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalRestartActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'consumeSuppressedPtyExit'
  | 'isPtyShutdownPending'
  | 'suppressPtyExit'
  | 'queuePaneAccountRestarts'
  | 'consumePendingPaneAccountRestart'
> {
  return {
    consumeSuppressedPtyExit: (ptyId) => {
      let wasSuppressed = false
      set((s) => {
        if (!s.suppressedPtyExitIds[ptyId]) {
          return s
        }
        wasSuppressed = true
        const next = { ...s.suppressedPtyExitIds }
        delete next[ptyId]
        return { suppressedPtyExitIds: next }
      })
      return wasSuppressed
    },
    isPtyShutdownPending: (ptyId) => (get().pendingPtyShutdownIds[ptyId] ?? 0) > 0,
    suppressPtyExit: (ptyId) => {
      set((s) => ({
        suppressedPtyExitIds: { ...s.suppressedPtyExitIds, [ptyId]: true }
      }))
    },
    queuePaneAccountRestarts: (ptyIds, agent) => {
      if (ptyIds.length === 0) {
        return
      }
      set((s) => ({
        pendingPaneAccountRestarts: {
          ...s.pendingPaneAccountRestarts,
          ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, agent] as const))
        }
      }))
    },
    consumePendingPaneAccountRestart: (ptyId) => {
      let queuedAgent: AccountRestartAgent | null = null
      set((s) => {
        const agent = s.pendingPaneAccountRestarts[ptyId]
        if (!agent) {
          return s
        }
        queuedAgent = agent
        const next = { ...s.pendingPaneAccountRestarts }
        delete next[ptyId]
        return { pendingPaneAccountRestarts: next }
      })
      return queuedAgent
    }
  }
}
