import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import { containsBrailleSpinner } from '../../../../shared/agent-title-core'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { resolveAgentTypeFromTerminalTitle } from '@/components/sidebar/worktree-title-derived-agent-rows'
import type { TerminalTab } from '../../../../shared/types'

function survivingPaneHostsSameAgentType(
  survivingPaneKeys: readonly string[],
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>,
  agentType: AgentType | null | undefined
): boolean {
  if (!agentType || agentType === 'unknown') {
    return false
  }
  return survivingPaneKeys.some((paneKey) => agentStatusByPaneKey[paneKey]?.agentType === agentType)
}

function resolveClosedPaneAgentType(args: {
  closedPaneKey: string
  closedPaneId?: number | null
  runtimePaneTitlesByPaneId?: Readonly<Record<number, string>>
  launchAgent?: TerminalTab['launchAgent']
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>
}): AgentType | null {
  const hookEntry = args.agentStatusByPaneKey[args.closedPaneKey]
  if (hookEntry?.agentType && hookEntry.agentType !== 'unknown') {
    return hookEntry.agentType
  }
  if (args.closedPaneId != null && args.runtimePaneTitlesByPaneId) {
    const title = args.runtimePaneTitlesByPaneId[args.closedPaneId]?.trim()
    if (title) {
      return resolveAgentTypeFromTerminalTitle(title, args.launchAgent)
    }
  }
  return args.launchAgent ?? null
}

type TabTitleFallbackFields = Pick<
  TerminalTab,
  'title' | 'defaultTitle' | 'quickCommandLabel' | 'customTitle'
>

export function shouldClearLaunchAgentForClosedPane(
  tab: Pick<TerminalTab, 'launchAgent' | 'ptyId'> | null | undefined,
  closedPtyId: string | null | undefined
): boolean {
  // Why: launchAgent describes the tab's original PTY only. Closing that PTY
  // must not transfer its bootstrap identity to a surviving shell sibling.
  return Boolean(tab?.launchAgent && closedPtyId && tab.ptyId === closedPtyId)
}

export function closedPaneHostedTitleDerivedAgent(args: {
  closedPaneId: number | null | undefined
  runtimePaneTitlesByPaneId?: Readonly<Record<number, string>>
  launchAgent?: TerminalTab['launchAgent']
}): boolean {
  if (args.closedPaneId == null || !args.runtimePaneTitlesByPaneId) {
    return false
  }
  const title = args.runtimePaneTitlesByPaneId[args.closedPaneId]?.trim()
  if (!title || classifyTitleActivity(title) === null) {
    return false
  }
  if (resolveAgentTypeFromTerminalTitle(title, args.launchAgent) !== null) {
    return true
  }
  // Why: hook-less agents (Codex/Cursor over SSH) surface only spinner+cwd titles.
  return containsBrailleSpinner(title) && Boolean(args.launchAgent)
}

export function shouldClearLaunchAgentAfterSplitPaneClose(args: {
  tab: Pick<TerminalTab, 'launchAgent' | 'ptyId'> | null | undefined
  closedPtyId: string | null | undefined
  closedPaneId?: number | null
  closedPaneKey: string | null
  runtimePaneTitlesByPaneId?: Readonly<Record<number, string>>
  survivingPaneKeys: readonly string[]
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>
}): boolean {
  if (shouldClearLaunchAgentForClosedPane(args.tab, args.closedPtyId)) {
    return true
  }
  if (!args.tab?.launchAgent || !args.closedPaneKey) {
    return false
  }
  const closedPaneHadAgent =
    args.closedPaneKey in args.agentStatusByPaneKey ||
    closedPaneHostedTitleDerivedAgent({
      closedPaneId: args.closedPaneId,
      runtimePaneTitlesByPaneId: args.runtimePaneTitlesByPaneId,
      launchAgent: args.tab.launchAgent
    })
  if (!closedPaneHadAgent) {
    return false
  }
  const closedAgentType = resolveClosedPaneAgentType({
    closedPaneKey: args.closedPaneKey,
    closedPaneId: args.closedPaneId,
    runtimePaneTitlesByPaneId: args.runtimePaneTitlesByPaneId,
    launchAgent: args.tab.launchAgent,
    agentStatusByPaneKey: args.agentStatusByPaneKey
  })
  return !survivingPaneHostsSameAgentType(
    args.survivingPaneKeys,
    args.agentStatusByPaneKey,
    closedAgentType
  )
}

export function resolveTabTitleAfterPaneClose(
  runtimePaneTitlesByPaneId: Readonly<Record<number, string>>,
  activePaneId: number | null | undefined,
  tab?: TabTitleFallbackFields | null
): string {
  const survivorTitle =
    activePaneId == null ? '' : (runtimePaneTitlesByPaneId[activePaneId]?.trim() ?? '')
  if (survivorTitle) {
    return survivorTitle
  }

  const stableTitle =
    tab?.customTitle?.trim() || tab?.quickCommandLabel?.trim() || tab?.defaultTitle?.trim() || ''
  if (stableTitle) {
    return stableTitle
  }

  const liveTitle = tab?.title?.trim() ?? ''
  if (liveTitle && classifyTitleActivity(liveTitle) === null) {
    return liveTitle
  }

  // Why: an empty update resets the tab to its stable fallback instead of
  // leaving the closed pane's agent title attached to an untitled survivor.
  return ''
}
