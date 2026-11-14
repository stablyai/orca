import { getTerminalNoticeLifetime } from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import { collectLeafIds } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-layout-tree'
import { awaitsCodexRestartAnswer } from '@/components/codex-restart-notice-state'
import { getResourceExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { AppState } from '../types'
import type { CodexAccountRestart, PaneAccountRestart } from './terminal-contracts'

export type CodexRestartPopulationState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'codexRestartNoticeByPtyId'
  | 'paneAccountRestarts'
> &
  WorktreeRuntimeOwnerState

export type CodexRestartPane = {
  key: string
  worktreeId: string
  tabId: string
  tabCreatedAt: number
  leafId: string | null
  ptyId: string
  shellOverride?: string
}

export function currentCodexRestartPanes(
  state: Pick<
    CodexRestartPopulationState,
    'tabsByWorktree' | 'terminalLayoutsByTabId' | 'ptyIdsByTabId'
  >
): Map<string, CodexRestartPane> {
  const panes = new Map<string, CodexRestartPane>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = state.terminalLayoutsByTabId[tab.id]
      const ids = state.ptyIdsByTabId[tab.id] ?? []
      const bound = new Set(ids)
      const leaves = new Set(collectLeafIds(layout?.root))
      for (const [leaf, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
        if (!bound.has(ptyId) || !isTerminalLeafId(leaf) || !leaves.has(leaf)) {
          continue
        }
        panes.set(ptyId, {
          key: makePaneKey(tab.id, leaf),
          worktreeId,
          tabId: tab.id,
          tabCreatedAt: tab.createdAt,
          leafId: leaf,
          ptyId,
          shellOverride: tab.shellOverride
        })
      }
      // A live legacy surface is actionable as a failure; it has no authority to kill/create a process.
      if (ids.length === 1 && !panes.has(ids[0]) && !layout?.root) {
        panes.set(ids[0], {
          key: `${tab.id}:unresolved`,
          worktreeId,
          tabId: tab.id,
          tabCreatedAt: tab.createdAt,
          leafId: null,
          ptyId: ids[0],
          shellOverride: tab.shellOverride
        })
      }
    }
  }
  return panes
}

export function isCodexAccountRestart(
  value: PaneAccountRestart | undefined
): value is CodexAccountRestart {
  return typeof value === 'object' && value?.agent === 'codex'
}

export function isCurrentCodexAccountRestart(
  state: CodexRestartPopulationState,
  request: CodexAccountRestart,
  tabs?: ReadonlyMap<string, CodexRestartTabScope>
): boolean {
  if (getResourceExecutionHostIdForWorktree(state, request.worktreeId) !== request.hostId) {
    return false
  }
  if (request.environmentId && request.pairingRevision !== undefined) {
    const environment = state.runtimeEnvironments?.find((e) => e.id === request.environmentId)
    if (
      environment &&
      'createdAt' in environment &&
      (('pairingRevision' in environment ? environment.pairingRevision : undefined) ??
        environment.createdAt) !== request.pairingRevision
    ) {
      return false
    }
  }
  const scope = tabs?.get(`${request.worktreeId}\0${request.tabId}`)
  const createdAt = tabs
    ? scope?.createdAt
    : state.tabsByWorktree[request.worktreeId]?.find((t) => t.id === request.tabId)?.createdAt
  if (createdAt === undefined || createdAt !== request.tabCreatedAt) {
    return false
  }
  if (!request.leafId) {
    const incarnation = getTerminalNoticeLifetime(request.oldPtyId)?.incarnationId
    return (
      (state.ptyIdsByTabId[request.tabId] ?? []).includes(request.oldPtyId) &&
      (!request.oldIncarnationId || !incarnation || incarnation === request.oldIncarnationId)
    )
  }
  const layout = state.terminalLayoutsByTabId[request.tabId]
  if (
    !layout ||
    !(tabs ? scope?.leaves.has(request.leafId) : layoutContainsLeafId(layout.root, request.leafId))
  ) {
    return false
  }
  const current = layout.ptyIdsByLeafId?.[request.leafId]
  const incarnation = current ? getTerminalNoticeLifetime(current)?.incarnationId : undefined
  if (
    current === request.oldPtyId &&
    current !== request.resultPtyId &&
    request.oldIncarnationId &&
    incarnation &&
    incarnation !== request.oldIncarnationId
  ) {
    return false
  }
  return !current || current === request.oldPtyId || current === request.resultPtyId
}

export function pruneCodexAccountRestarts(
  state: CodexRestartPopulationState
): AppState['paneAccountRestarts'] {
  let next = state.paneAccountRestarts
  if (!Object.values(next).some(isCodexAccountRestart)) {
    return next
  }
  const tabs = codexRestartTabIndex(state)
  for (const [key, request] of Object.entries(next)) {
    if (!isCodexAccountRestart(request) || isCurrentCodexAccountRestart(state, request, tabs)) {
      continue
    }
    if (next === state.paneAccountRestarts) {
      next = { ...next }
    }
    delete next[key]
  }
  return next
}

export type CodexAccountRestartToken = Pick<
  CodexAccountRestart,
  'requestId' | 'attemptId' | 'executorId'
> & {
  key: string
}
export function codexAccountRestartToken(
  request: Pick<CodexAccountRestart, 'tabId' | 'leafId' | 'requestId' | 'attemptId' | 'executorId'>
): CodexAccountRestartToken {
  return {
    key: request.leafId
      ? makePaneKey(request.tabId, request.leafId)
      : `${request.tabId}:unresolved`,
    requestId: request.requestId,
    attemptId: request.attemptId,
    executorId: request.executorId
  }
}

export function currentCodexAccountRestart(
  state: CodexRestartPopulationState,
  token: CodexAccountRestartToken
): CodexAccountRestart | null {
  const request = state.paneAccountRestarts[token.key]
  return isCodexAccountRestart(request) &&
    request.requestId === token.requestId &&
    request.attemptId === token.attemptId &&
    request.executorId === token.executorId &&
    isCurrentCodexAccountRestart(state, request)
    ? request
    : null
}

function reconcileRetiredCodexNotices(
  before: AppState,
  next: AppState
): AppState['codexRestartNoticeByPtyId'] {
  let notices = next.codexRestartNoticeByPtyId
  let panes: ReturnType<typeof currentCodexRestartPanes> | undefined
  for (const [key, request] of Object.entries(before.paneAccountRestarts)) {
    if (!isCodexAccountRestart(request) || isCodexAccountRestart(next.paneAccountRestarts[key])) {
      continue
    }
    const notice = notices[request.oldPtyId]
    if (
      !notice?.restartRequested ||
      (notice.incarnationId && notice.incarnationId !== request.oldIncarnationId)
    ) {
      continue
    }
    panes ??= currentCodexRestartPanes(next)
    const pane = panes.get(request.oldPtyId)
    const incarnation = getTerminalNoticeLifetime(request.oldPtyId)?.incarnationId
    const originalStillCurrent =
      pane &&
      getResourceExecutionHostIdForWorktree(next, pane.worktreeId) === request.hostId &&
      (!incarnation || !request.oldIncarnationId || incarnation === request.oldIncarnationId)
    if (notices === next.codexRestartNoticeByPtyId) {
      notices = { ...notices }
    }
    if (originalStillCurrent) {
      const { restartRequested: _answered, ...unanswered } = notice
      notices[request.oldPtyId] = unanswered
    } else {
      delete notices[request.oldPtyId]
    }
  }
  return notices
}

export function withCodexAccountRestartPruning(
  state: AppState,
  patch: Partial<AppState>
): Partial<AppState> {
  if (
    patch.tabsByWorktree === undefined &&
    patch.terminalLayoutsByTabId === undefined &&
    patch.ptyIdsByTabId === undefined &&
    patch.paneAccountRestarts === undefined
  ) {
    return patch
  }
  const next = { ...state, ...patch }
  const requests = pruneCodexAccountRestarts(next)
  const notices = reconcileRetiredCodexNotices(state, { ...next, paneAccountRestarts: requests })
  return requests === next.paneAccountRestarts && notices === next.codexRestartNoticeByPtyId
    ? patch
    : { ...patch, paneAccountRestarts: requests, codexRestartNoticeByPtyId: notices }
}

type CodexRestartTabScope = { createdAt: number; leaves: ReadonlySet<string> }
export function codexRestartTabIndex(
  state: Pick<CodexRestartPopulationState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>
): ReadonlyMap<string, CodexRestartTabScope> {
  return new Map(
    Object.entries(state.tabsByWorktree).flatMap(([worktreeId, tabs]) =>
      tabs.map(
        (tab) =>
          [
            `${worktreeId}\0${tab.id}`,
            {
              createdAt: tab.createdAt,
              leaves: new Set(collectLeafIds(state.terminalLayoutsByTabId[tab.id]?.root))
            }
          ] as const
      )
    )
  )
}

export function eligibleCodexRestartPtyIds(
  state: CodexRestartPopulationState,
  panes = currentCodexRestartPanes(state),
  currentRequests?: readonly CodexAccountRestart[]
): string[] {
  if (!currentRequests) {
    const requests = Object.values(state.paneAccountRestarts).filter(isCodexAccountRestart)
    const tabs = requests.length ? codexRestartTabIndex(state) : undefined
    currentRequests = requests.filter((request) =>
      isCurrentCodexAccountRestart(state, request, tabs)
    )
  }
  const coveredPtys = new Set(
    currentRequests.flatMap((request) =>
      request.resultPtyId ? [request.oldPtyId, request.resultPtyId] : [request.oldPtyId]
    )
  )
  return [...panes].flatMap(([ptyId, pane]) =>
    !coveredPtys.has(ptyId) &&
    !isCodexAccountRestart(state.paneAccountRestarts[pane.key]) &&
    awaitsCodexRestartAnswer(state.codexRestartNoticeByPtyId[ptyId])
      ? [ptyId]
      : []
  )
}
