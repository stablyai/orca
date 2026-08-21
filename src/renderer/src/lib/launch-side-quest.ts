import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { useAppStore } from '@/store'
import type { SideQuestAgent } from './side-quest-agent'
import { sideQuestReadOnlyAgentArgs } from './side-quest-agent'

export type LaunchSideQuestResult =
  | { status: 'started'; groupId: string; terminalTabId: string }
  | {
      status: 'failed' | 'feature-disabled' | 'missing-source-group' | 'runtime-unsupported'
    }

export function launchSideQuest(args: {
  worktreeId: string
  sourceGroupId: string | null
  agent: SideQuestAgent
  beforeOpenChat?: (terminalTabId: string, transport: 'provider' | 'terminal') => void
}): LaunchSideQuestResult {
  if (!args.sourceGroupId) {
    return { status: 'missing-source-group' }
  }

  const initialState = useAppStore.getState()
  if (initialState.settings?.experimentalNativeChat !== true) {
    return { status: 'feature-disabled' }
  }
  const sourceGroupExists = initialState.groupsByWorktree[args.worktreeId]?.some(
    (group) => group.id === args.sourceGroupId
  )
  if (!sourceGroupExists) {
    return { status: 'missing-source-group' }
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(initialState, args.worktreeId)
  // Why: host-owned tabs do not return their new tab id to this renderer yet,
  // so Orca cannot safely bind the pending quote to the correct chat surface.
  if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return { status: 'runtime-unsupported' }
  }

  const worktree = initialState
    .allWorktrees?.()
    .find((candidate) => candidate.id === args.worktreeId)
  const repo = worktree
    ? initialState.repos?.find((candidate) => candidate.id === worktree.repoId)
    : null

  const groupId = initialState.createEmptySplitGroup(args.worktreeId, args.sourceGroupId, 'right')
  if (!groupId) {
    return { status: 'failed' }
  }

  // Why: app-server currently runs on Orca's local execution host. SSH repos
  // retain the terminal path until the runtime relay can host this protocol.
  if (args.agent === 'codex' && worktree && !repo?.connectionId) {
    return startLocalCodexProviderSideQuest({
      worktreeId: args.worktreeId,
      groupId,
      worktreePath: worktree.path,
      beforeOpenChat: args.beforeOpenChat
    })
  }

  return startTerminalCompatibilitySideQuest({
    worktreeId: args.worktreeId,
    groupId,
    agent: args.agent,
    beforeOpenChat: args.beforeOpenChat
  })
}

function startLocalCodexProviderSideQuest(args: {
  worktreeId: string
  groupId: string
  worktreePath: string
  beforeOpenChat?: (terminalTabId: string, transport: 'provider' | 'terminal') => void
}): LaunchSideQuestResult {
  const initialState = useAppStore.getState()
  const now = Date.now()
  const sessionId = crypto.randomUUID()
  const tab = initialState.createTab(args.worktreeId, args.groupId, undefined, {
    launchAgent: 'codex',
    quickCommandLabel: 'Side Quest',
    viewMode: 'chat'
  })
  initialState.setTabSideQuestSession(tab.id, {
    id: sessionId,
    provider: 'codex',
    providerThreadId: null,
    status: 'starting',
    error: null,
    createdAt: now,
    updatedAt: now
  })
  const unifiedTab = useAppStore
    .getState()
    .unifiedTabsByWorktree[args.worktreeId]?.find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tab.id
    )
  if (!unifiedTab) {
    initialState.closeTab(tab.id)
    useAppStore.getState().closeEmptyGroup(args.worktreeId, args.groupId)
    return { status: 'failed' }
  }
  args.beforeOpenChat?.(tab.id, 'provider')
  initialState.setTabCustomLabel(unifiedTab.id, 'Side Quest')
  void window.api.sideQuest
    .create({ cwd: tab.startupCwd ?? args.worktreePath })
    .then(({ providerThreadId }) => {
      const state = useAppStore.getState()
      const current = state.tabsByWorktree[args.worktreeId]?.find(
        (candidate) => candidate.id === tab.id
      )?.sideQuestSession
      if (!current || current.id !== sessionId) {
        return
      }
      state.setTabSideQuestSession(tab.id, {
        ...current,
        providerThreadId,
        status: 'ready',
        updatedAt: Date.now()
      })
    })
    .catch((error: unknown) => {
      const state = useAppStore.getState()
      const current = state.tabsByWorktree[args.worktreeId]?.find(
        (candidate) => candidate.id === tab.id
      )?.sideQuestSession
      if (!current || current.id !== sessionId) {
        return
      }
      state.setTabSideQuestSession(tab.id, {
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now()
      })
    })
  return { status: 'started', groupId: args.groupId, terminalTabId: tab.id }
}

function startTerminalCompatibilitySideQuest(args: {
  worktreeId: string
  groupId: string
  agent: SideQuestAgent
  beforeOpenChat?: (terminalTabId: string, transport: 'provider' | 'terminal') => void
}): LaunchSideQuestResult {
  const launched = launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    groupId: args.groupId,
    agentArgs: sideQuestReadOnlyAgentArgs(args.agent),
    // Why: user command overrides may embed unrestricted flags that would
    // defeat the shared-worktree read-only guarantee.
    ignoreConfiguredAgentCommand: true,
    quickCommandLabel: 'Side Quest'
  })
  if (!launched?.tabId) {
    useAppStore.getState().closeEmptyGroup(args.worktreeId, args.groupId)
    return { status: 'failed' }
  }

  const state = useAppStore.getState()
  const unifiedTab = state.unifiedTabsByWorktree[args.worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === launched.tabId
  )
  if (!unifiedTab) {
    // Why: a partially-created launch must not leave a hidden agent or an
    // unusable split behind if the unified-tab invariant ever fails.
    state.closeTab(launched.tabId)
    useAppStore.getState().closeEmptyGroup(args.worktreeId, args.groupId)
    return { status: 'failed' }
  }
  // Why: the composer reads pending context on its first render, so callers
  // must be able to seed it before switching this tab into native chat.
  args.beforeOpenChat?.(launched.tabId, 'terminal')
  state.setTabViewMode(unifiedTab.id, 'chat')
  state.setTabCustomLabel(unifiedTab.id, 'Side Quest')

  return { status: 'started', groupId: args.groupId, terminalTabId: launched.tabId }
}
