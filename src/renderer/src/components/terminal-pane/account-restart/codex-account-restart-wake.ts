import { useAppStore } from '@/store'
import {
  codexAccountRestartToken,
  currentCodexAccountRestart,
  isCodexAccountRestart,
  isCurrentCodexAccountRestart,
  type CodexAccountRestartToken
} from '@/store/terminals/codex-account-restart-continuation'
import { getResourceExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { getTerminalNoticeLifetime } from '../provider-notices/terminal-notice-lifetime'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { parseRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  prepareCodexAccountRestart,
  resolveCodexAccountRestartPane
} from './codex-account-restart-owner'
import {
  failCodexAccountRestart,
  retryCodexAccountRestarts
} from './codex-account-restart-execution'
import { paneResumeOwnershipElsewhere } from '../pty-connection/startup/pane-resume-owned-elsewhere'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'
import type { ConnectPanePtySession } from '../pty-connection/connect-pane-pty-session'
import type { FreshSpawnOptions } from '../pty-connection/startup/fresh-spawn-types'
import { readTerminalSpawnDeferral } from '../../../../../shared/terminal/pty/admission/spawn-admission-contract'
import { startDeferredSessionReattach } from '../pty-connection/reattach/deferred-session-reattach-connect'

async function settleForeignResume(
  session: ConnectPanePtySession,
  request: CodexAccountRestart
): Promise<boolean> {
  const startup = request.startup
  if (!startup?.resumeProviderSession) {
    return false
  }
  const candidate = paneResumeOwnershipElsewhere(session, null, {
    agent: 'codex',
    providerSession: startup.resumeProviderSession,
    paneKey: session.cacheKey
  })
  if (!candidate) {
    return false
  }
  const token = codexAccountRestartToken(request)
  if (candidate.kind === 'live') {
    const state = useAppStore.getState()
    const pane = parsePaneKey(candidate.paneKey)
    const entry = state.agentStatusByPaneKey.get(candidate.paneKey)
    const ptyId = pane
      ? state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
      : null
    const incarnation = ptyId ? getTerminalNoticeLifetime(ptyId)?.incarnationId : null
    const tab = pane
      ? Object.values(state.tabsByWorktree)
          .flat()
          .find((t) => t.id === pane.tabId)
      : null
    if (
      pane &&
      tab &&
      ptyId &&
      incarnation &&
      getResourceExecutionHostIdForWorktree(state, tab.worktreeId) === request.hostId
    ) {
      try {
        const resolved = await resolveCodexAccountRestartPane(request, {
          worktreeId: tab.worktreeId,
          ...pane,
          tabCreatedAt: tab.createdAt
        })
        const latest = useAppStore.getState()
        if (currentCodexAccountRestart(latest, token)?.phase !== 'preparing') {
          return true
        }
        const remote = parseRemoteRuntimePtyId(ptyId)
        if (
          resolved?.snapshot.owner?.incarnationId === incarnation &&
          'connected' in resolved.terminal &&
          resolved.terminal.connected === true &&
          (remote
            ? 'handle' in resolved.terminal && resolved.terminal.handle === remote.handle
            : resolved.snapshot.owner.ptyId === ptyId) &&
          latest.agentStatusByPaneKey.get(candidate.paneKey) === entry &&
          latest.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] === ptyId &&
          latest.ptyIdsByTabId[pane.tabId]?.includes(ptyId) &&
          latest.tabsByWorktree[tab.worktreeId]?.some(
            (t) => t.id === tab.id && t.createdAt === tab.createdAt
          ) &&
          getResourceExecutionHostIdForWorktree(latest, tab.worktreeId) === request.hostId &&
          getTerminalNoticeLifetime(ptyId)?.incarnationId === incarnation
        ) {
          latest.updateCodexAccountRestart(token, null)
          return true
        }
      } catch {
        // A disappearing foreign candidate is not proof this intent is superseded.
      }
    }
  }
  failCodexAccountRestart(token, 'terminal_pane_owner_unverified', 'failed', {
    notDispatched: true
  })
  return true
}

/** Undefined preserves ordinary routing; handled-null must never fall through to an ordinary start. */
export function routeCodexAccountRestartWake(
  session: ConnectPanePtySession,
  context: { token?: CodexAccountRestartToken } = { token: session.deps.accountRestartToken },
  options: FreshSpawnOptions = {}
): Promise<string | null> | undefined {
  const state = useAppStore.getState()
  const token = context.token
  if (!token) {
    const retained = state.pendingPaneAccountRestarts[session.cacheKey]
    if (!isCodexAccountRestart(retained) || !isCurrentCodexAccountRestart(state, retained)) {
      return undefined
    }
    const retainedToken = codexAccountRestartToken(retained)
    if (
      retained.phase === 'deferred' &&
      retained.startup &&
      retained.receipt?.outcome === 'terminal' &&
      retained.receipt.stop !== 'unknown'
    ) {
      session.deps.accountRestartToken = retainedToken
      session.enterSpawnDeferredSleep(
        readTerminalSpawnDeferral(retained.error) ?? 'paused',
        retained.startup,
        options,
        true
      )
    } else if (
      retained.phase === 'failed' &&
      retained.oldIncarnationId &&
      (retained.notDispatched ||
        (retained.receipt?.outcome === 'terminal' && retained.receipt.stop === 'not-started'))
    ) {
      const isCurrent = (result?: { id: string; incarnationId?: string | null }): boolean => {
        const latest = useAppStore.getState()
        return (
          !session.disposed &&
          session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport &&
          currentCodexAccountRestart(latest, retainedToken)?.phase === 'failed' &&
          latest.terminalLayoutsByTabId[retained.tabId]?.ptyIdsByLeafId?.[session.pane.leafId] ===
            retained.oldPtyId &&
          (!result ||
            (result.id === retained.oldPtyId && result.incarnationId === retained.oldIncarnationId))
        )
      }
      if (isCurrent()) {
        return startDeferredSessionReattach(session, retained.oldPtyId, {
          attachOnlyView: true,
          shouldContinue: isCurrent
        }).then(() => null)
      }
    }
    return Promise.resolve(null)
  }
  let request = currentCodexAccountRestart(state, token)
  if (!request || session.disposed) {
    return Promise.resolve(null)
  }
  if (request.phase === 'dispatched' || request.phase === 'unresolved') {
    if (request.phase === 'dispatched') {
      state.updateCodexAccountRestart(token, { phase: 'unresolved' })
      request = currentCodexAccountRestart(useAppStore.getState(), token)
    }
    return request ? retryCodexAccountRestarts([request]).then(() => null) : Promise.resolve(null)
  }
  if (request.phase === 'deferred') {
    request = state.claimCodexAccountRestart(token.key, token)
  }
  if (!request || request.phase !== 'claimed') {
    return Promise.resolve(null)
  }
  const attempt = codexAccountRestartToken(request)
  const generation = session.transportStreamGeneration
  state.updateCodexAccountRestart(attempt, { phase: 'preparing' })
  session.deps.accountRestartToken = attempt
  session.deps.accountRestart = undefined
  return (async () => {
    if (await settleForeignResume(session, request)) {
      return null
    }
    const condition = await prepareCodexAccountRestart(request)
    const current = currentCodexAccountRestart(useAppStore.getState(), attempt)
    if (!condition || !current?.startup || current.phase !== 'preparing') {
      return null
    }
    if (
      session.disposed ||
      generation !== session.transportStreamGeneration ||
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
    ) {
      failCodexAccountRestart(attempt, 'terminal_account_restart_view_changed', 'failed', {
        notDispatched: true
      })
      return null
    }
    session.deps.accountRestart = condition
    return session.startFreshSpawn(current.startup, options)
  })().catch((error: unknown) => {
    failCodexAccountRestart(attempt, error, 'failed', { notDispatched: true })
    return null
  })
}
