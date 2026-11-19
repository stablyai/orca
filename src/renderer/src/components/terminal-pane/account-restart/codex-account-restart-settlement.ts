import { useAppStore } from '@/store'
import {
  currentCodexAccountRestart,
  type CodexAccountRestartToken
} from '@/store/terminals/codex-account-restart-continuation'
import { failCodexAccountRestart } from './codex-account-restart-execution'
import {
  ACCOUNT_RESTART_OUTCOME_UNKNOWN,
  ACCOUNT_RESTART_VIEW_CHANGED,
  readAccountRestartReceipt
} from '../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'

export function settleCodexAccountRestart(
  session: ConnectPanePtySession,
  token: CodexAccountRestartToken,
  outcome: {
    ptyId: string | null
    generation: number
    error: unknown
    deferred: boolean
    retireOptions: () => void
  }
): boolean {
  const state = useAppStore.getState()
  const retireOptions = (): void => {
    if (session.deps.accountRestartToken !== token) {
      return
    }
    session.deps.accountRestartToken = undefined
    session.deps.accountRestart = undefined
    outcome.retireOptions()
  }
  const request = currentCodexAccountRestart(state, token)
  if (!request) {
    retireOptions()
    return false
  }
  if (outcome.deferred && request.phase === 'deferred') {
    return false
  }
  if (session.disposed || outcome.generation !== session.transportStreamGeneration) {
    if (!request.resultPtyId && readAccountRestartReceipt(outcome.error)?.outcome === 'terminal') {
      failCodexAccountRestart(token, outcome.error, outcome.deferred ? 'deferred' : 'failed')
      return false
    }
    state.updateCodexAccountRestart(token, {
      phase: 'unresolved',
      error: ACCOUNT_RESTART_VIEW_CHANGED
    })
    return false
  }
  if (
    outcome.ptyId &&
    outcome.ptyId === request.resultPtyId &&
    request.resultIncarnationId &&
    request.resultIncarnationId === session.remotePtyIncarnationId &&
    session.activePanePtyBinding === outcome.ptyId &&
    session.transport.getPtyId() === outcome.ptyId &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  ) {
    session.deps.invalidateRetainedInlineScrollback(session.pane.leafId)
    retireOptions()
    state.updateCodexAccountRestart(token, null)
    return true
  }
  failCodexAccountRestart(
    token,
    outcome.error ?? ACCOUNT_RESTART_OUTCOME_UNKNOWN,
    outcome.deferred ? 'deferred' : 'failed'
  )
  return false
}
