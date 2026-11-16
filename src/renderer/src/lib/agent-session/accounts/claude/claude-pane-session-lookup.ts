import { useAppStore } from '@/store/index'
import { getCodexSelectionLaneKey } from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { AgentProviderSessionMetadata } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { isSessionHeldByAnotherPane } from '@/lib/agent-session/identity/claude-session-pane-holders'
import { warnSessionsLeftBehind } from '@/lib/provider-accounts/claude-account-switch-notices'
import type { ClaudeHostFolders } from './claude-pane-account-folder'
import { localClaudePanes } from './claude-pane-inventory'
import { findQueuedClaudeRestartsOnAccount } from './claude-session-account-move'
import {
  carriesLookedUpClaudeSession,
  keepQueuedClaudeRestarts,
  type ClaudePaneLookups
} from './claude-queued-restart-records'

type QueuedRestartScope = {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  accountId: string | null
  host?: ClaudeHostFolders
  restartAll: boolean
}

let switchedToLabel = ''

export async function lookUpClaudePaneSession(
  ptyId: string
): Promise<AgentProviderSessionMetadata | null> {
  try {
    return await window.api.pty.discoverClaudeSession(ptyId)
  } catch {
    return null
  }
}

async function lookUpUnnamedPanes(
  scope: Pick<QueuedRestartScope, 'owner' | 'target' | 'restartAll'>
): Promise<ClaudePaneLookups> {
  if (!scope.restartAll) {
    return new Map()
  }
  const hostLane = getCodexSelectionLaneKey(null)
  const panes = localClaudePanes(useAppStore.getState(), scope.owner, scope.target, true)
  const unnamed = [...panes].filter(
    (pane) => pane.inLane && pane.laneKey === hostLane && (!pane.entry || !pane.resumable)
  )
  return new Map(
    await Promise.all(
      unnamed.map(
        async (pane) =>
          [makePaneKey(pane.tabId, pane.leafId), await lookUpClaudePaneSession(pane.ptyId)] as const
      )
    )
  )
}

function cancelQueuedRestartsOnAccount(
  scope: QueuedRestartScope,
  discovered?: ClaudePaneLookups
): void {
  const store = useAppStore.getState()
  for (const ptyId of findQueuedClaudeRestartsOnAccount({ ...scope, discovered })) {
    store.consumePendingPaneAccountRestart(ptyId)
  }
}

function cancelLookedUpRestartsWithoutEntry(scope: QueuedRestartScope): void {
  const state = useAppStore.getState()
  for (const pane of localClaudePanes(state, scope.owner, scope.target, true)) {
    if (
      pane.inLane &&
      !pane.entry &&
      state.pendingPaneAccountRestarts[pane.ptyId] === 'claude' &&
      carriesLookedUpClaudeSession(pane.ptyId)
    ) {
      state.consumePendingPaneAccountRestart(pane.ptyId)
    }
  }
}

function cancelSharedQueuedRestarts(scope: QueuedRestartScope, lookups: ClaudePaneLookups): number {
  const state = useAppStore.getState()
  let lookedUp = 0
  for (const pane of localClaudePanes(state, scope.owner, scope.target, true, lookups)) {
    const paneKey = makePaneKey(pane.tabId, pane.leafId)
    if (
      state.pendingPaneAccountRestarts[pane.ptyId] === 'claude' &&
      pane.sessionId &&
      isSessionHeldByAnotherPane(state, paneKey, pane.sessionId, lookups) &&
      (!!pane.lookedUp || !isSessionHeldByAnotherPane(state, paneKey, pane.sessionId))
    ) {
      lookedUp += carriesLookedUpClaudeSession(pane.ptyId) ? 1 : 0
      state.consumePendingPaneAccountRestart(pane.ptyId)
    }
  }
  return lookedUp
}

export async function settleQueuedClaudeRestarts(
  scope: QueuedRestartScope & { accountLabel: string; isCurrent: () => boolean }
): Promise<ClaudePaneLookups> {
  if (!scope.restartAll) {
    cancelLookedUpRestartsWithoutEntry(scope)
  }
  cancelQueuedRestartsOnAccount(scope)
  const lookups = await lookUpUnnamedPanes(scope)
  if (!scope.isCurrent()) {
    return lookups
  }
  cancelQueuedRestartsOnAccount(scope, lookups)
  const shared = cancelSharedQueuedRestarts(scope, lookups)
  if (shared > 0) {
    warnSessionsLeftBehind(shared, scope.accountLabel)
  }
  keepQueuedClaudeRestarts(useAppStore.getState().pendingPaneAccountRestarts)
  switchedToLabel = scope.accountLabel
  return lookups
}

export function discoveredRestartAccountLabel(): string {
  return switchedToLabel
}
