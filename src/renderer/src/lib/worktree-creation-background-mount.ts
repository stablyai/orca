import type { StructuredLaunchTerminal } from '@/lib/agent-session/launch/structured-agent-session-launch-admission'
import { buildWorktreeCreationStartupOpt } from '@/lib/worktree-creation-flow-startup'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { useAppStore } from '@/store'
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
  heldChatMessage: string | undefined
): StructuredLaunchTerminal {
  const built = buildWorktreeCreationStartupOpt(args.request, false)
  // The submit-time plan never saw a message sent while the worktree was created; leave it unsent in the agent's input.
  const startup =
    built && heldChatMessage && !built.draftPrompt
      ? { ...built, draftPrompt: heldChatMessage }
      : built
  if (host.kind === 'environment') {
    ensureWebRuntimeWorktreeTerminalAfterWake(args.worktreeId, {
      startup,
      agent: args.request.agent,
      activate: false
    })
    return { opened: true }
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
