import { activateTabAndFocusPane } from '../lib/activate-tab-and-focus-pane'
import { useAppStore } from '../store'
import { matchesWebSessionIntentOwner } from './web-runtime-session-environment'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session-snapshot'
import { webSessionIntentOwnerKey, type WebSessionIntentOwner } from './web-session-intent-owner'
import {
  clearWebSessionFocusIntentIfMatches,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import { toHostSessionTabId, toWebTerminalSurfaceTabId } from './web-terminal-surface-id'
import type { RuntimeTerminalSplit } from '../../../shared/runtime-types'

export type WebRuntimeSplitSource = { worktreeId: string; tabId: string; leafId: string }

type WebRuntimeSplitFocusTarget = {
  worktreeId: string
  sourceTabId: string
  sourceLeafId: string
  sourcePtyId: string
  expectedActiveWorktreeId: string | null
  expectedExecutionHostId: string | null
  expectedCurrentLocalTabId: string | null
  expectedCurrentLocalLeafId: string | null
}

type WebRuntimeSplitFocusRequest = { key: string; id: number }
const latestWebRuntimeSplitFocusRequestByKey = new Map<string, number>()
let nextWebRuntimeSplitFocusRequestId = 0

export function beginWebRuntimeSplitFocusRequest(
  owner: WebSessionIntentOwner,
  worktreeId: string
): WebRuntimeSplitFocusRequest {
  const request = {
    key: `${webSessionIntentOwnerKey(owner)}\0${worktreeId}`,
    id: ++nextWebRuntimeSplitFocusRequestId
  }
  latestWebRuntimeSplitFocusRequestByKey.set(request.key, request.id)
  return request
}

function isLatestWebRuntimeSplitFocusRequest(request: WebRuntimeSplitFocusRequest | null): boolean {
  return Boolean(request && latestWebRuntimeSplitFocusRequestByKey.get(request.key) === request.id)
}

export function finishWebRuntimeSplitFocusRequest(
  request: WebRuntimeSplitFocusRequest | null
): void {
  if (request && isLatestWebRuntimeSplitFocusRequest(request)) {
    latestWebRuntimeSplitFocusRequestByKey.delete(request.key)
  }
}

export function captureWebRuntimeSplitFocusTarget(
  ptyId: string,
  source: WebRuntimeSplitSource
): WebRuntimeSplitFocusTarget | null {
  const state = useAppStore.getState()
  if (!state) {
    return null
  }
  const sourceTab = state.tabsByWorktree?.[source.worktreeId]?.find(
    (tab) => tab.id === source.tabId
  )
  if (
    !sourceTab ||
    state.terminalLayoutsByTabId?.[source.tabId]?.ptyIdsByLeafId?.[source.leafId] !== ptyId
  ) {
    return null
  }
  const expectedActiveWorktreeId = state.activeWorktreeId ?? null
  const expectedCurrentLocalTabId = expectedActiveWorktreeId
    ? resolveWebSessionVisibleTabId(state, expectedActiveWorktreeId)
    : null
  return {
    worktreeId: source.worktreeId,
    sourceTabId: source.tabId,
    sourceLeafId: source.leafId,
    sourcePtyId: ptyId,
    expectedActiveWorktreeId,
    expectedExecutionHostId: state.activeWorkspaceExecutionHostId ?? null,
    expectedCurrentLocalTabId,
    expectedCurrentLocalLeafId: expectedCurrentLocalTabId
      ? (state.terminalLayoutsByTabId?.[expectedCurrentLocalTabId]?.activeLeafId ?? null)
      : null
  }
}

function matchesWebRuntimeSplitFocusTarget(
  target: WebRuntimeSplitFocusTarget,
  hostTabId: string,
  newLeafId?: string
): boolean {
  const state = useAppStore.getState()
  if (
    !state ||
    toHostSessionTabId(target.sourceTabId) !== hostTabId ||
    state.terminalLayoutsByTabId?.[target.sourceTabId]?.ptyIdsByLeafId?.[target.sourceLeafId] !==
      target.sourcePtyId ||
    (state.activeWorktreeId ?? null) !== target.expectedActiveWorktreeId ||
    (state.activeWorkspaceExecutionHostId ?? null) !== target.expectedExecutionHostId
  ) {
    return false
  }
  const currentTabId = target.expectedActiveWorktreeId
    ? resolveWebSessionVisibleTabId(state, target.expectedActiveWorktreeId)
    : null
  if (currentTabId === target.expectedCurrentLocalTabId) {
    const currentLeafId = currentTabId
      ? (state.terminalLayoutsByTabId?.[currentTabId]?.activeLeafId ?? null)
      : null
    return currentLeafId === target.expectedCurrentLocalLeafId
  }
  return Boolean(
    currentTabId &&
    newLeafId &&
    toHostSessionTabId(currentTabId) === hostTabId &&
    state.terminalLayoutsByTabId?.[currentTabId]?.activeLeafId === newLeafId
  )
}

export async function focusSplitWebRuntimeTerminalPane(
  owner: WebSessionIntentOwner,
  target: WebRuntimeSplitFocusTarget | null,
  request: WebRuntimeSplitFocusRequest | null,
  split: RuntimeTerminalSplit | undefined
): Promise<void> {
  const hostTabId = split?.tabId?.trim()
  const leafId = split?.leafId?.trim()
  if (
    !hostTabId ||
    !leafId ||
    !target ||
    !isLatestWebRuntimeSplitFocusRequest(request) ||
    !matchesWebSessionIntentOwner(owner) ||
    !matchesWebRuntimeSplitFocusTarget(target, hostTabId)
  ) {
    return
  }
  recordWebSessionFocusIntent(
    owner,
    target.worktreeId,
    hostTabId,
    leafId,
    target.expectedCurrentLocalTabId
  )
  await refreshWebRuntimeSessionTabsSnapshot(owner.environmentId, target.worktreeId, {
    expectedEnvironmentPairingRevision: owner.pairingRevision,
    acceptCurrentSnapshot: true
  })
  if (
    !isLatestWebRuntimeSplitFocusRequest(request) ||
    !matchesWebSessionIntentOwner(owner) ||
    !matchesWebRuntimeSplitFocusTarget(target, hostTabId, leafId)
  ) {
    if (isLatestWebRuntimeSplitFocusRequest(request)) {
      clearWebSessionFocusIntentIfMatches(owner, target.worktreeId, hostTabId, leafId)
    }
    return
  }
  activateTabAndFocusPane(toWebTerminalSurfaceTabId(hostTabId), leafId)
}
