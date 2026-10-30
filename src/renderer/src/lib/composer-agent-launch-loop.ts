import { useAppStore } from '@/store'
import { launchAgentInNewTab, type LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  usesAgentLaunchList,
  type AgentLaunchListEntry,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

type SeededTerminalState = {
  tabsByWorktree: Record<
    string,
    {
      id: string
      launchAgent?: string
      customTitle: string | null
      quickCommandLabel?: string | null
      viewMode?: 'terminal' | 'chat'
    }[]
  >
  pendingStartupByTabId: Record<string, unknown>
  pendingIssueCommandSplitByTabId: Record<string, unknown>
  closeTab: (tabId: string, opts: { captureRecentlyClosed: boolean }) => void
}

export type ComposerAgentLaunchLoopArgs = {
  worktreeId: string
  request: WorktreeCreationRequest
  quickPrompt: string
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  linkedItemPrompt: string | null
  /** The creation pipeline's seeded terminal; left alone when it carries setup or issue work. */
  seededTerminalTabId?: string | null
}

export type ComposerAgentLaunchLoopResult = {
  launched: number
  failed: number
}

/** A seeded creation terminal is blank only while nothing has claimed it: no agent stamp,
 * startup command, issue split, custom label or chat mode. */
function isBlankSeededTerminal(
  state: SeededTerminalState,
  worktreeId: string,
  tabId: string
): boolean {
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
  if (!tab) {
    return false
  }
  return (
    !tab.launchAgent &&
    !tab.customTitle &&
    !tab.quickCommandLabel &&
    tab.viewMode !== 'chat' &&
    !state.pendingStartupByTabId[tabId] &&
    !state.pendingIssueCommandSplitByTabId[tabId]
  )
}

/** Resolution 1: the multi-agent path owns every surface, so the blank terminal seeded for an
 * agent-less creation is redundant. Setup/issue/default tabs carry their own work and stay.
 * The read happens per close: closing the worktree's last tab deactivates it mid-creation. */
function closeSeededBlankTerminal(args: {
  getState: () => SeededTerminalState
  worktreeId: string
  seededTerminalTabId: string | null
}): void {
  const candidateTabIds = args.seededTerminalTabId
    ? [args.seededTerminalTabId]
    : (args.getState().tabsByWorktree[args.worktreeId] ?? []).map((tab) => tab.id)
  for (const tabId of candidateTabIds) {
    const state = args.getState()
    // Why: an emptied worktree applies the landing patch, so a lone tab stays until an agent tab exists.
    if ((state.tabsByWorktree[args.worktreeId] ?? []).length <= 1) {
      return
    }
    if (isBlankSeededTerminal(state, args.worktreeId, tabId)) {
      state.closeTab(tabId, { captureRecentlyClosed: false })
    }
  }
}

/** Serializable list entries become the same launch the tab bar uses. Flags cannot ride a
 * chat, so an entry carrying `agentArgs` forces its terminal surface (resolution 4). */
function launchArgsForEntry(args: {
  worktreeId: string
  entry: AgentLaunchListEntry
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  activate: boolean
}): LaunchAgentInNewTabArgs {
  const { entry } = args
  const agentArgs = entry.agentArgs
  const requestedSurface =
    agentArgs !== undefined && agentArgs !== null && agentArgs.trim() !== ''
      ? 'terminal'
      : entry.requestedSurface
  return {
    requestId: newAgentLaunchRequestId(),
    agent: entry.agent,
    worktreeId: args.worktreeId,
    launchSource: 'new_workspace_composer',
    pendingActivationSpawn: true,
    activate: args.activate,
    promptDelivery: args.promptDelivery,
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(entry.sessionOptions ? { sessionOptions: entry.sessionOptions } : {}),
    ...(entry.sessionOptionsYieldToAgentArgs ? { sessionOptionsYieldToAgentArgs: true } : {}),
    ...(requestedSurface ? { requestedSurface } : {}),
    ...(args.prompt.trim() ? { prompt: args.prompt } : {}),
    ...(entry.displayName?.trim() ? { quickCommandLabel: entry.displayName.trim() } : {})
  }
}

/**
 * Launch every `agentLaunches` entry, in order, into the freshly created workspace.
 * The first entry focuses the workspace; later launches keep its tab selected. Entry
 * failures stay local to the entry so the rest of the list still starts (resolution 5).
 */
export function runComposerAgentLaunchLoop(
  args: ComposerAgentLaunchLoopArgs
): ComposerAgentLaunchLoopResult {
  const entries = args.request.agentLaunches ?? []
  if (!usesAgentLaunchList(args.request) || entries.length === 0) {
    return { launched: 0, failed: 0 }
  }

  const prompt = args.linkedItemPrompt ?? args.quickPrompt
  const promptDelivery =
    args.promptDelivery ?? (args.linkedItemPrompt !== null ? 'draft' : 'auto-submit')
  const canFocus = args.request.suppressTerminalFocusOnCompletion !== true
  let launched = 0
  let failed = 0

  for (const [index, entry] of entries.entries()) {
    try {
      const result = launchAgentInNewTab(
        launchArgsForEntry({
          worktreeId: args.worktreeId,
          entry,
          prompt,
          promptDelivery,
          activate: canFocus && index === 0
        })
      )
      if (result) {
        launched += 1
      } else {
        failed += 1
      }
    } catch (error) {
      // Keep later rows launching; the launch stack already reports command/prompt failures.
      console.error('composer: agent launch failed', entry.agent, error)
      failed += 1
    }
    if (index === 0) {
      // Resolution 1: absorb the seeded blank terminal once the first agent tab exists, so
      // closing it never empties (and therefore deactivates) the freshly created worktree.
      closeSeededBlankTerminal({
        getState: () => useAppStore.getState(),
        worktreeId: args.worktreeId,
        seededTerminalTabId: args.seededTerminalTabId ?? null
      })
    }
  }

  return { launched, failed }
}
