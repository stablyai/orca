import { useAppStore } from '@/store'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import { queueHookCommandsForFirstWorktreeTab } from '@/lib/hook-command-delayed-delivery'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { TuiAgent } from '../../../shared/tui-agent'

type AppStoreSnapshot = ReturnType<typeof useAppStore.getState>

type SeedRequest = Pick<WorktreeCreationRequest, 'agent' | 'startupPlan' | 'launchDraftPrompt'>

/** Find the actual agent tab, never tabs[0] or activation’s primary: default dev/log/shell tabs run no agent. */
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
    return runtimeEnvironmentIdOrLocalUnlessTwin(state, args.worktreeId)
      ? toWebTerminalSurfaceTabId(args.startupTerminalTabId)
      : args.startupTerminalTabId
  }
  const stamped = worktreeTabs.find((tab) => tab.launchAgent === args.agent)?.id
  // Renderer startup is queued on primaryTabId, making it the agent’s tab by construction.
  return stamped ?? args.primaryTabId ?? args.startupTerminalTabId ?? null
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
  seedNativeChatAppliedSessionOptions(tabId, agent, request.startupPlan?.sessionOptions)
  // Mirror draft launch context into chat composer; otherwise TUI-only input is invisible there.
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
  // Runtime tabs mirror asynchronously; retain seeds until agent-tab identity arrives instead of dropping draft context.
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
      // Without a stamped agent tab, accept only a sole mirrored tab. Consumed seeds cannot retry, and default tabs must never receive agent drafts.
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
