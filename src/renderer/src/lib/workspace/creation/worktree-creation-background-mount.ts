import { launchAgentInWebHostTab } from '@/lib/agent-session/launch/new-tab/launch-agent-web-host-tab'
import type { StructuredLaunchTerminal } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import { buildWorktreeCreationStartupOpt } from '@/lib/workspace/creation/worktree-creation-flow-startup'
import { ensureWorktreeHasInitialTerminal } from '@/lib/workspace/activation/initial-surface/worktree-initial-terminal-seeding'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { useAppStore } from '@/store/index'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'

/** Mount startup-owing tabs without activating: hidden workspaces otherwise never run renderer agent/setup/issue startup despite announcing readiness. */
export function mountCreatedWorktreeStartupTabsInBackground(worktreeId: string): void {
  const state = useAppStore.getState()
  const tabIds = (state.tabsByWorktree[worktreeId] ?? [])
    .map((tab) => tab.id)
    .filter(
      (tabId) =>
        state.pendingStartupByTabId[tabId] !== undefined ||
        state.pendingIssueCommandSplitByTabId[tabId] !== undefined
    )
  if (tabIds.length > 0) {
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds })
  }
}

/** Host-declined chats keep background creates in place without navigation (#23974); still-visible creates use normal agent-tab fallback. */
export function openBackgroundDeclinedTerminal(
  args: { request: WorktreeCreationRequest; worktreeId: string },
  host: RuntimeClientTarget,
  heldChatMessage: string | undefined,
  signal?: AbortSignal
): StructuredLaunchTerminal {
  const built = buildWorktreeCreationStartupOpt(args.request, false)
  // The submit-time plan never saw a message sent while the worktree was created; leave it unsent in the agent's input.
  const startup =
    built && heldChatMessage && !built.draftPrompt
      ? { ...built, draftPrompt: heldChatMessage }
      : built
  if (host.kind === 'environment' && args.request.agent) {
    const completion = launchAgentInWebHostTab({
      ...(built?.freshAgentLaunch ?? args.request.launchInputs),
      submitFollowup: true,
      agent: args.request.agent,
      environmentId: host.environmentId,
      worktreeId: args.worktreeId,
      prompt: heldChatMessage ?? args.request.launchDraftPrompt ?? args.request.quickPrompt,
      promptDelivery: heldChatMessage || args.request.launchDraftPrompt ? 'draft' : 'auto-submit',
      activate: false,
      selectWorktree: false,
      isCancelled: () => signal?.aborted === true,
      buildStartup: () => {
        const rebuilt = args.request.creationStartup?.legacy(
          heldChatMessage ?? args.request.launchDraftPrompt ?? args.request.quickPrompt,
          heldChatMessage || args.request.launchDraftPrompt ? 'draft' : 'auto-submit'
        )
        if (rebuilt?.promptPlan) {
          return rebuilt.promptPlan
        }
        const plan = rebuilt?.startupPlan ?? args.request.startupPlan
        return {
          startupPlan: plan,
          pasteDraftAfterLaunch: plan?.draftPrompt ?? plan?.followupPrompt ?? null,
          submitPastedPrompt: Boolean(plan?.followupPrompt)
        }
      }
    })
    return {
      opened: true,
      completion,
      promptDeliveryResult: completion.then(({ delivered, failureNotified }) => ({
        delivered,
        failureNotified
      }))
    }
  }
  if (!startup) {
    return { opened: false }
  }
  // This machine seeds the agent terminal itself; a background workspace mounts it without showing it.
  const tabId = ensureWorktreeHasInitialTerminal(
    useAppStore.getState(),
    args.worktreeId,
    startup,
    undefined,
    undefined,
    undefined,
    { activateCreatedTabs: false, createNewTerminalForStartup: true }
  )
  mountCreatedWorktreeStartupTabsInBackground(args.worktreeId)
  return { opened: tabId !== null }
}
