import { useAppStore } from '@/store'
import { getProviderSessionClaimKey } from '../../../../../../shared/sleeping-record-legacy-pane-key'
import type { SleepingAgentSessionRecord } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentTurnEndedUncleanly } from '../../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

// Why live+done arms too: kept from #16308's wake-sweep widening; hibernation itself only writes worktree-sleep notes.
export function noteArmsHibernatedPaneWake(record: SleepingAgentSessionRecord): boolean {
  return (
    record.state === 'done' &&
    record.origin !== 'quit' &&
    !(record.origin === 'live' && agentTurnEndedUncleanly(record))
  )
}

export function installHibernatedPaneWake(session: ConnectPanePtySession): void {
  // Suppressed hidden hibernation exits still owe a wake; retain the exact PTY/record so a later session cannot be adopted.
  session.hibernatedWakeTarget = null
  session.wakeHibernatedAgentPane = null
  // Latch mobile wakes between record write and kill-exit arming; mobile never reveals the desktop to retry the lost edge.
  session.pendingHibernatedWakeTarget = null
  // Claim the provider session throughout async replacement spawn so repeated mobile activation cannot duplicate resume.
  session.hibernatedWakeInFlightClaimKey = null
  // Share guarded wake consumption between reveal and arm-time visibility checks so a reveal racing kill resumes exactly once.
  session.consumeHibernatedAgentWake = (claimedProviderSessions?: Set<string>): string | null => {
    const target = session.hibernatedWakeTarget
    if (!target || session.disposed) {
      return null
    }
    if (session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport) {
      return null
    }
    const currentRecord = session.getSleepingRecordForPane(useAppStore.getState())?.record
    // Why claim keys: a held pane can wait a whole session, and a re-capture of the same session must not strand it.
    if (
      !currentRecord ||
      getProviderSessionClaimKey(currentRecord) !== getProviderSessionClaimKey(target.record)
    ) {
      session.hibernatedWakeTarget = null
      session.pendingHibernatedWakeTarget = null
      return null
    }
    const currentPtyId = session.transport.getPtyId()
    // Null or the old PTY means no replacement; a different bound ID proves another flow already owns the pane.
    if (currentPtyId !== null && currentPtyId !== target.ptyId) {
      session.hibernatedWakeTarget = null
      session.pendingHibernatedWakeTarget = null
      return null
    }
    if (!session.wakeHibernatedAgentPane) {
      return null
    }
    const claimKey = getProviderSessionClaimKey(target.record)
    if (claimedProviderSessions?.has(claimKey)) {
      return null
    }
    // Claim synchronously before spawn because one wake visits multiple aliases of the same provider session.
    claimedProviderSessions?.add(claimKey)
    session.hibernatedWakeTarget = null
    session.pendingHibernatedWakeTarget = null
    session.hibernatedWakeInFlightClaimKey = claimKey
    // Reveal must resume the recorded session or fresh shell behind the otherwise frozen frame.
    const wake: () => Promise<string | null> = target.wake ?? session.wakeHibernatedAgentPane
    void wake()
      .then((spawnedPtyId) => {
        if (!spawnedPtyId) {
          // On transient spawn failure, re-arm the exact retained record so later mobile wakes can retry after full ownership validation.
          session.hibernatedWakeTarget = target
        }
      })
      .finally(() => {
        if (session.hibernatedWakeInFlightClaimKey === claimKey) {
          session.hibernatedWakeInFlightClaimKey = null
        }
      })
    return claimKey
  }
}
