import { useAppStore } from '@/store/index'
import {
  getCodexSelectionLaneKey,
  normalizeCodexAccountSelectionTarget
} from '../../../../../../shared/codex-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/codex-selection-lane'
import type { AgentProviderSessionMetadata } from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { isSessionHeldByAnotherPane } from '@/lib/agent-session/identity/claude-session-pane-holders'
import { warnSessionsLeftBehind } from '@/lib/provider-accounts/claude-account-switch-notices'
import { isClaudePaneOnAccount, resolveClaudePaneFolder } from './claude-pane-account-folder'
import type { ClaudeHostFolders } from './claude-pane-account-folder'
import { claudeSwitchCandidatePanes, hasSleepingSession } from './claude-switch-candidate-panes'
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
  const state = useAppStore.getState()
  const hostLane = getCodexSelectionLaneKey(null)
  const panes = claudeSwitchCandidatePanes(state, scope.owner, scope.target, scope.restartAll)
  const unnamed = [...panes].filter(
    (pane) =>
      pane.inLane &&
      pane.laneKey === hostLane &&
      !pane.session &&
      (!pane.entry || !hasSleepingSession(state, pane))
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

export function findQueuedClaudeRestartsOnAccount(
  args: QueuedRestartScope & { discovered?: ClaudePaneLookups }
): string[] {
  const state = useAppStore.getState()
  const saved = state.settings?.claudeManagedAccounts ?? []
  const host =
    normalizeCodexAccountSelectionTarget(args.target).runtime === 'host' ? args.host : undefined
  const panes = claudeSwitchCandidatePanes(
    state,
    args.owner,
    args.target,
    args.restartAll,
    args.discovered
  )
  const ptyIds: string[] = []
  for (const pane of panes) {
    if (
      pane.inLane &&
      state.pendingPaneAccountRestarts[pane.ptyId] === 'claude' &&
      isClaudePaneOnAccount(
        resolveClaudePaneFolder(pane.session?.transcriptPath, saved, host),
        args.accountId,
        host
      )
    ) {
      ptyIds.push(pane.ptyId)
    }
  }
  return ptyIds
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
  for (const pane of claudeSwitchCandidatePanes(state, scope.owner, scope.target, true)) {
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
  for (const pane of claudeSwitchCandidatePanes(state, scope.owner, scope.target, true, lookups)) {
    const paneKey = makePaneKey(pane.tabId, pane.leafId)
    if (
      state.pendingPaneAccountRestarts[pane.ptyId] === 'claude' &&
      pane.session &&
      isSessionHeldByAnotherPane(state, paneKey, pane.session.id, lookups) &&
      (pane.identifiedBy === 'lookup' ||
        !isSessionHeldByAnotherPane(state, paneKey, pane.session.id))
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
