import { ACCOUNT_RESTART_VIEW_CHANGED } from '../../../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import {
  isObsoleteCodexRestartResult,
  failCodexAccountRestart
} from '../../account-restart/codex-account-restart-execution'
import { currentCodexAccountRestart } from '@/store/terminals/codex-account-restart-continuation'
import { useAppStore } from '@/store'
import { armPaneOwnerRetry } from '../host-ownership/pane-owner-recovery'
import { pendingSpawnByPaneKey } from './pending-pane-spawn'
import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'
import type { FreshSpawnOptions, PendingStartupCommand } from '../startup/fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function settleFreshPaneSpawn(
  session: ConnectPanePtySession,
  {
    spawnedPtyId,
    accountError,
    accountDeferred,
    ownerRefused,
    generation,
    startupOverride,
    options
  }: {
    spawnedPtyId: string | null
    accountError: string | null
    accountDeferred: boolean
    ownerRefused: boolean
    generation: number
    startupOverride: PendingStartupCommand | null | undefined
    options: FreshSpawnOptions
  }
): void {
  const accountToken = session.deps.accountRestartToken
  if (accountToken && !accountDeferred) {
    if (spawnedPtyId) {
      const request = currentCodexAccountRestart(useAppStore.getState(), accountToken)
      if (!request) {
        return
      }
      if (
        isObsoleteCodexRestartResult(request, {
          id: spawnedPtyId,
          incarnationId: session.remotePtyIncarnationId
        })
      ) {
        useAppStore.getState().updateCodexAccountRestart(accountToken, null)
        return
      }
      if (session.disposed || generation !== session.transportStreamGeneration) {
        useAppStore.getState().updateCodexAccountRestart(accountToken, {
          phase: 'unresolved',
          error: ACCOUNT_RESTART_VIEW_CHANGED
        })
        return
      }
      if (
        request?.resultPtyId === spawnedPtyId &&
        !session.disposed &&
        session.transport.getPtyId() === spawnedPtyId
      ) {
        session.deps.invalidateRetainedInlineScrollback(session.pane.leafId)
        session.deps.accountRestartToken = undefined
        session.deps.accountRestart = undefined
        useAppStore.getState().updateCodexAccountRestart(accountToken, null)
      }
    } else {
      failCodexAccountRestart(
        accountToken,
        accountError ?? 'terminal_account_restart_outcome_unknown'
      )
    }
  }
  if (spawnedPtyId && !session.disposed && generation === session.transportStreamGeneration) {
    // Fresh-spawn recovery has no reattach settle point; report binding here so healed attempts cannot remain pending and block later recovery.
    session.settlePaneAttachAttempt?.('success')
    return
  }
  queueMicrotask(() => {
    if (
      session.disposed ||
      generation !== session.transportStreamGeneration ||
      session.transport.getPtyId() ||
      pendingSpawnByPaneKey.has(session.pendingSpawnKey)
    ) {
      return
    }
    if (accountToken) {
      return
    }
    if (ownerRefused) {
      armPaneOwnerRetry(session, generation, () =>
        session.startFreshSpawn(startupOverride, options)
      )
      session.settlePaneAttachAttempt?.('failed')
      return
    }
    if (session.deferredSpawn) {
      // Why no remount: the host would defer the remount's restore again, in a loop.
      return
    }
    settleSpawnThatLeftPaneUnbound(session)
  })
}
