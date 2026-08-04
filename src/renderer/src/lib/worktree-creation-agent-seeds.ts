import { useAppStore } from '@/store'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { queueHookCommandsForFirstWorktreeTab } from '@/lib/hook-command-delayed-delivery'
import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { toWebTerminalSurfaceTabId } from '@/runtime/web-terminal-surface-id'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { TuiAgent } from '../../../shared/types'

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

type SeedRequest = Pick<WorktreeCreationRequest, 'agent' | 'startupPlan' | 'launchDraftPrompt'>

/**
 * Resolve the tab the launch agent actually runs in.
 *
 * Deliberately never falls back to `tabs[0]`: with repo default terminal tabs
 * (e.g. "dev server", "logs", "shell") the worktree's first tab runs no agent,
 * and activation's `primaryTabId` is only the worktree's primary tab.
 */
function resolveLaunchAgentTabId(
  state: AppStoreSnapshot,
  args: {
    agent: TuiAgent
    worktreeId: string
    primaryTabId: string | null
    startupTerminalTabId: string | null | undefined
    backendSpawned: boolean
  }
): string | null {
  const worktreeTabs = state.tabsByWorktree[args.worktreeId] ?? []
  // Main spawned the agent itself, so its startup tab is authoritative.
  if (args.backendSpawned && args.startupTerminalTabId) {
    return getRuntimeEnvironmentIdForWorktree(state, args.worktreeId)
      ? toWebTerminalSurfaceTabId(args.startupTerminalTabId)
      : args.startupTerminalTabId
  }
  const stamped = worktreeTabs.find((tab) => tab.launchAgent === args.agent)?.id
  // Why: when the renderer owns startup, `ensureAgentStartupInTerminal` queues it
  // on primaryTabId, so that tab is the agent's tab by construction.
  return stamped ?? args.primaryTabId ?? args.startupTerminalTabId ?? null
}

function applyBackendSpawnedDraftViewMode(args: {
  state: AppStoreSnapshot
  request: SeedRequest
  agent: TuiAgent
  tabId: string
  worktreeId: string
  backendSpawned: boolean
}): void {
  const { state, request, agent, tabId, worktreeId, backendSpawned } = args
  if (!backendSpawned || !request.launchDraftPrompt) {
    return
  }
  const desiredViewMode =
    decideInitialAgentTabViewMode({
      experimentalNativeChat: state.settings?.experimentalNativeChat,
      openAgentTabsInChatByDefault: state.settings?.openAgentTabsInChatByDefault,
      agent,
      promptDelivery: 'draft',
      launchDraftText: request.launchDraftPrompt,
      ...(agent === 'grok'
        ? {
            nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
              getConnectionIdFromState(state, worktreeId)
            )
          }
        : {})
    }) ?? 'terminal'
  const tab = state.unifiedTabsByWorktree?.[worktreeId]?.find((tab) => tab.id === tabId)
  if (!tab && getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
      setWebRuntimeTabProps({ worktreeId, tabId, viewMode: desiredViewMode })
    )
    return
  }
  const currentViewMode = tab?.viewMode ?? 'terminal'
  if (currentViewMode !== desiredViewMode) {
    state.setTabViewMode(tabId, desiredViewMode)
  }
}

function applyAgentTabSeeds(args: {
  state: AppStoreSnapshot
  request: SeedRequest
  agent: TuiAgent
  tabId: string
  worktreeId: string
  backendSpawned: boolean
}): void {
  const { request, agent, tabId } = args
  applyBackendSpawnedDraftViewMode(args)
  seedNativeChatAppliedSessionOptions(tabId, agent, request.startupPlan?.sessionOptions)
  // Why: draft launch context reaches only the TUI input; seed the
  // chat-composer copy so it isn't invisible in the chat view.
  if (request.launchDraftPrompt) {
    seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text: request.launchDraftPrompt })
  }
}

/**
 * Seed per-tab agent state (applied session options + the chat-composer copy of
 * draft launch context) once a created worktree's launch tab is known.
 */
export function seedAgentTabStateAfterWorktreeCreate(args: {
  request: SeedRequest
  worktreeId: string
  primaryTabId: string | null
  startupTerminalTabId: string | null | undefined
  backendSpawned: boolean
}): void {
  const { request, worktreeId, backendSpawned } = args
  const agent = request.agent
  if (!request.startupPlan || !agent) {
    return
  }
  const state = useAppStore.getState()
  const tabId = resolveLaunchAgentTabId(state, { ...args, agent })
  if (tabId) {
    applyAgentTabSeeds({ state, request, agent, tabId, worktreeId, backendSpawned })
    return
  }
  if ((state.tabsByWorktree[worktreeId] ?? []).length > 0) {
    // Tabs exist but none is the agent's; seeding one anyway would publish the
    // draft on a tab that runs no agent.
    return
  }
  // Why: runtime-owned (web session) worktrees mirror their session tabs async,
  // so there is no tab to seed yet — hold the seed for the first mirrored tab
  // instead of dropping it and leaving the draft invisible on that host class.
  queueHookCommandsForFirstWorktreeTab({
    worktreeId,
    deliver: (state, firstTerminalTabId) => {
      const mirroredTabId = resolveLaunchAgentTabId(state, { ...args, agent })
      if (mirroredTabId) {
        applyAgentTabSeeds({
          state,
          request,
          agent,
          tabId: mirroredTabId,
          worktreeId,
          backendSpawned
        })
        return
      }
      // Why: same invariant as the synchronous branch — never seed a tab that
      // runs no agent. The queue entry is consumed before delivery (no retry),
      // so accept the first mirrored tab only when it is the worktree's only
      // one and therefore unambiguously the agent's.
      if ((state.tabsByWorktree[worktreeId] ?? []).length === 1) {
        applyAgentTabSeeds({
          state,
          request,
          agent,
          tabId: firstTerminalTabId,
          worktreeId,
          backendSpawned
        })
      }
    }
  })
}
