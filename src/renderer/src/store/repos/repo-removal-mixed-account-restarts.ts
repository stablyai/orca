import type { AppState } from '../types'
import type { CodexAccountRestart } from '../terminals/terminal-contracts'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  codexAccountRestartToken,
  codexRestartTabIndex,
  isCodexAccountRestart,
  isCurrentCodexAccountRestart
} from '../terminals/codex-account-restart-continuation'
import { getTerminalNoticeLifetime } from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import type { RemovedHostTwinState } from './repo-removal-host-twin-attribution'

export type MixedAccountRestart = Pick<
  CodexAccountRestart,
  | 'requestId'
  | 'attemptId'
  | 'executorId'
  | 'worktreeId'
  | 'tabId'
  | 'tabCreatedAt'
  | 'leafId'
  | 'hostId'
  | 'hostEpoch'
  | 'environmentId'
  | 'pairingRevision'
  | 'runtimeId'
  | 'oldPtyId'
  | 'oldIncarnationId'
  | 'resultPtyId'
  | 'resultIncarnationId'
>

export function captureMixedAccountRestarts(
  state: AppState,
  hostId: ExecutionHostId,
  removed: RemovedHostTwinState
): ReadonlyMap<string, MixedAccountRestart> {
  if (removed.mixedTabPtyIds.size === 0) {
    return new Map()
  }
  const candidates = Object.entries(state.pendingPaneAccountRestarts ?? {}).filter(
    ([key, r]) =>
      isCodexAccountRestart(r) &&
      r.hostId === hostId &&
      r.leafId &&
      codexAccountRestartToken(r).key === key &&
      removed.mixedTabPtyIds.has(r.oldPtyId)
  )
  const captured = new Map<string, MixedAccountRestart>()
  const tabs = candidates.length ? codexRestartTabIndex(state) : undefined
  for (const [key, r] of candidates) {
    if (
      !isCodexAccountRestart(r) ||
      !r.leafId ||
      !isCurrentCodexAccountRestart(state, r, tabs) ||
      state.terminalLayoutsByTabId[r.tabId]?.ptyIdsByLeafId?.[r.leafId] !== r.oldPtyId
    ) {
      continue
    }
    captured.set(key, {
      requestId: r.requestId,
      attemptId: r.attemptId,
      executorId: r.executorId,
      worktreeId: r.worktreeId,
      tabId: r.tabId,
      tabCreatedAt: r.tabCreatedAt,
      leafId: r.leafId,
      hostId: r.hostId,
      hostEpoch: r.hostEpoch,
      environmentId: r.environmentId,
      pairingRevision: r.pairingRevision,
      runtimeId: r.runtimeId,
      oldPtyId: r.oldPtyId,
      oldIncarnationId: getTerminalNoticeLifetime(r.oldPtyId)?.incarnationId ?? r.oldIncarnationId,
      resultPtyId: r.resultPtyId,
      resultIncarnationId: r.resultIncarnationId
    })
  }
  return captured
}

function matchesCapturedAccountRestart(
  state: AppState,
  r: CodexAccountRestart,
  captured: MixedAccountRestart | undefined,
  tabs: ReturnType<typeof codexRestartTabIndex> | undefined
): boolean {
  if (
    !captured ||
    !r.leafId ||
    r.requestId !== captured.requestId ||
    r.attemptId !== captured.attemptId ||
    r.executorId !== captured.executorId ||
    r.worktreeId !== captured.worktreeId ||
    r.tabId !== captured.tabId ||
    r.tabCreatedAt !== captured.tabCreatedAt ||
    r.leafId !== captured.leafId ||
    r.hostId !== captured.hostId ||
    r.hostEpoch !== captured.hostEpoch ||
    r.environmentId !== captured.environmentId ||
    r.pairingRevision !== captured.pairingRevision ||
    r.runtimeId !== captured.runtimeId ||
    r.oldPtyId !== captured.oldPtyId ||
    // Why: a reply published during the await is the same attempt; only an unbound leaf qualifies below.
    (captured.resultPtyId !== undefined &&
      (r.resultPtyId !== captured.resultPtyId ||
        r.resultIncarnationId !== captured.resultIncarnationId)) ||
    (r.oldIncarnationId && r.oldIncarnationId !== captured.oldIncarnationId) ||
    !isCurrentCodexAccountRestart(state, r, tabs)
  ) {
    return false
  }
  const bound = state.terminalLayoutsByTabId[r.tabId]?.ptyIdsByLeafId?.[r.leafId]
  const incarnation = bound ? getTerminalNoticeLifetime(bound)?.incarnationId : undefined
  return (
    !bound ||
    (bound === captured.oldPtyId && (!incarnation || incarnation === captured.oldIncarnationId))
  )
}

/** A retired PTY ends a continuation only while the continuation's own tab holds that process. */
function retiresWithPty(
  state: AppState,
  r: CodexAccountRestart,
  ptyId: string | undefined,
  incarnationId: string | undefined,
  retiredPtyIds: ReadonlySet<string>
): boolean {
  if (!ptyId || !retiredPtyIds.has(ptyId)) {
    return false
  }
  // Why: a relay can reuse an ended endpoint's ID in another project's tab; that request is not this pane's.
  const live = getTerminalNoticeLifetime(ptyId)?.incarnationId
  return (
    (state.ptyIdsByTabId[r.tabId] ?? []).includes(ptyId) &&
    (!incarnationId || !live || live === incarnationId)
  )
}

/** Retirement evidence only: these checks never add a PTY to the removal's kill candidates. */
export function retiresRemovedHostAccountRestart(
  state: AppState,
  r: CodexAccountRestart,
  retiredPtyIds: ReadonlySet<string>,
  captured: MixedAccountRestart | undefined,
  tabs: ReturnType<typeof codexRestartTabIndex> | undefined
): boolean {
  return (
    retiresWithPty(state, r, r.oldPtyId, r.oldIncarnationId, retiredPtyIds) ||
    retiresWithPty(state, r, r.resultPtyId, r.resultIncarnationId, retiredPtyIds) ||
    matchesCapturedAccountRestart(state, r, captured, tabs)
  )
}
