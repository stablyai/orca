import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { detectAgentStatusFromTitle, isClaudeAgent } from '@/lib/agent-status'
import { makePaneKey } from '../../../shared/stable-pane-id'

export type LiveClaudeSessionRestartPlan = {
  livePtyIds: string[]
  workInProgressPtyIds: string[]
}

function normalizeProcessName(processName: string | null): string | null {
  if (!processName) {
    return null
  }
  return processName.toLowerCase().replace(/\.exe$/, '')
}

function isClaudeForegroundProcess(processName: string | null): boolean {
  const normalized = normalizeProcessName(processName)
  return (
    normalized === 'claude' ||
    normalized === 'claude-code' ||
    normalized?.startsWith('claude-') === true
  )
}

type RestartCandidateTab = AppState['tabsByWorktree'][string][number]
type AgentStatusEntry = AppState['agentStatusByPaneKey'][string]

function getPaneKeyForPtyId(state: AppState, tabId: string, ptyId: string): string | null {
  const ptyIdsByLeafId = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  for (const [leafId, leafPtyId] of Object.entries(ptyIdsByLeafId)) {
    if (leafPtyId === ptyId) {
      return makePaneKey(tabId, leafId)
    }
  }
  return null
}

function isClaudeStatusEntry(entry: AgentStatusEntry | undefined): boolean {
  return entry?.agentType === 'claude'
}

function isActiveClaudeStatusEntry(entry: AgentStatusEntry | undefined): boolean {
  return isClaudeStatusEntry(entry) && entry?.state !== 'done'
}

function titleIndicatesActiveClaudeWork(title: string | null | undefined): boolean {
  if (!title || !isClaudeAgent(title)) {
    return false
  }
  if (title.startsWith('. ')) {
    return true
  }
  const titleStatus = detectAgentStatusFromTitle(title)
  return titleStatus === 'working' || titleStatus === 'permission'
}

function tabHasClaudeIdentityHint(state: AppState, tab: RestartCandidateTab): boolean {
  if (tab.launchAgent === 'claude' || isClaudeAgent(tab.title)) {
    return true
  }
  return Object.values(state.runtimePaneTitlesByTabId[tab.id] ?? {}).some((title) =>
    isClaudeAgent(title)
  )
}

function tabHasActiveClaudeWorkTitle(state: AppState, tab: RestartCandidateTab): boolean {
  if (titleIndicatesActiveClaudeWork(tab.title)) {
    return true
  }
  return Object.values(state.runtimePaneTitlesByTabId[tab.id] ?? {}).some((title) =>
    titleIndicatesActiveClaudeWork(title)
  )
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export async function getLiveClaudeSessionRestartPlan(
  state: AppState = useAppStore.getState()
): Promise<LiveClaudeSessionRestartPlan> {
  const tabs = Object.values(state.tabsByWorktree).flat()
  const tabChecks = await Promise.all(
    tabs.map(async (tab) => {
      const ptyIds = state.ptyIdsByTabId[tab.id] ?? []
      if (ptyIds.length === 0) {
        return { livePtyIds: [], workInProgressPtyIds: [] }
      }

      const titleHintsClaude = tabHasClaudeIdentityHint(state, tab)
      const titleHintsActiveWork = tabHasActiveClaudeWorkTitle(state, tab)
      const foregroundProcesses = await Promise.all(
        ptyIds.map((ptyId) =>
          inspectRuntimeTerminalProcess(state.settings, ptyId)
            .then((inspection) => inspection.foregroundProcess)
            .catch(() => null)
        )
      )
      const livePtyIds: string[] = []
      const workInProgressPtyIds: string[] = []
      for (const [index, ptyId] of ptyIds.entries()) {
        const paneKey = getPaneKeyForPtyId(state, tab.id, ptyId)
        const paneStatus = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
        const isLiveClaudeSession =
          isClaudeForegroundProcess(foregroundProcesses[index] ?? null) ||
          isClaudeStatusEntry(paneStatus) ||
          (ptyIds.length === 1 && titleHintsClaude)
        if (!isLiveClaudeSession) {
          continue
        }
        livePtyIds.push(ptyId)
        if (isActiveClaudeStatusEntry(paneStatus) || titleHintsActiveWork) {
          workInProgressPtyIds.push(ptyId)
        }
      }
      return { livePtyIds, workInProgressPtyIds }
    })
  )

  return {
    livePtyIds: sortedUnique(tabChecks.flatMap((check) => check.livePtyIds)),
    workInProgressPtyIds: sortedUnique(tabChecks.flatMap((check) => check.workInProgressPtyIds))
  }
}

export function markClaudeSessionsForRestart(args: {
  ptyIds: string[]
  previousAccountLabel: string
  nextAccountLabel: string
  forceRestart?: boolean
}): void {
  if (args.ptyIds.length === 0) {
    return
  }
  useAppStore.getState().markClaudeRestartNotices(
    args.ptyIds.map((ptyId) => ({
      ptyId,
      previousAccountLabel: args.previousAccountLabel,
      nextAccountLabel: args.nextAccountLabel,
      forceRestart: args.forceRestart
    }))
  )
}
