import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { agentTypeToIconAgent } from '../../../../shared/agent-status/presentation/agent-type-icon-agent'
import { selectTabBarAgentProjections } from '../tab-bar/tab-agent-types-by-tab-id'
import { orderWorktreeLeadingTabs } from './worktree-card-leading-tab-order'

/** The card's leading icon shows this many tabs: the front one and up to three layered behind it. */
export const LEADING_TAB_LIMIT = 4

/** What one layer draws, matching the icon the tab bar shows for that tab. */
export type LeadingTabIcon =
  | { kind: 'agent'; agent: TerminalAgent | null }
  | { kind: 'shell'; shell: string }
  | { kind: 'browser'; faviconUrl: string | null }
  | { kind: 'file'; filePath: string }
  | { kind: 'simulator' }

// Encoded as strings so `useShallow` can compare the list across store updates.
function encode(icon: LeadingTabIcon): string {
  switch (icon.kind) {
    case 'agent':
      return `agent\n${icon.agent ?? ''}`
    case 'shell':
      return `shell\n${icon.shell}`
    case 'browser':
      return `browser\n${icon.faviconUrl ?? ''}`
    case 'file':
      return `file\n${icon.filePath}`
    case 'simulator':
      return 'simulator\n'
  }
}

export function decodeLeadingTabIcon(encoded: string): LeadingTabIcon {
  const split = encoded.indexOf('\n')
  const kind = encoded.slice(0, split)
  const value = encoded.slice(split + 1)
  switch (kind) {
    case 'agent':
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `encode` writes this value, from a TerminalAgent.
      return { kind: 'agent', agent: value ? (value as TerminalAgent) : null }
    case 'shell':
      return { kind: 'shell', shell: value }
    case 'browser':
      return { kind: 'browser', faviconUrl: value || null }
    case 'file':
      return { kind: 'file', filePath: value }
    default:
      return { kind: 'simulator' }
  }
}

function iconForTab(state: AppState, tab: Tab, worktreeId: string): LeadingTabIcon {
  switch (tab.contentType) {
    case 'terminal': {
      // Agent-status pane keys use the backing terminal tab id, not the unified tab id.
      const detected = selectTabBarAgentProjections(state).tabAgentTypesByTabId[tab.entityId]
      const terminalTab = state.tabsByWorktree[worktreeId]?.find((t) => t.id === tab.entityId)
      const agent = agentTypeToIconAgent(detected) ?? terminalTab?.launchAgent ?? null
      return agent
        ? { kind: 'agent', agent }
        : { kind: 'shell', shell: terminalTab?.shellOverride ?? '' }
    }
    case 'agent-session':
      return { kind: 'agent', agent: agentTypeToIconAgent(tab.agentSessionAgent) }
    case 'browser': {
      const page = state.browserTabsByWorktree[worktreeId]?.find((b) => b.id === tab.entityId)
      return { kind: 'browser', faviconUrl: page?.faviconUrl ?? null }
    }
    case 'simulator':
      return { kind: 'simulator' }
    case 'editor':
    case 'diff':
    case 'conflict-review':
    case 'check-details':
    case 'git-graph':
      return { kind: 'file', filePath: tab.entityId }
  }
}

/** The worktree's leading tabs in the sidebar sort's order, encoded for shallow comparison. */
export function selectWorktreeLeadingTabs(state: AppState, worktreeId: string): string[] {
  return orderWorktreeLeadingTabs(state, worktreeId)
    .slice(0, LEADING_TAB_LIMIT)
    .map((tab) => encode(iconForTab(state, tab, worktreeId)))
}

/** Keep ordering and icon projection out of unrelated store notifications. */
export function createWorktreeLeadingTabsSelector(worktreeId: string) {
  let previous: readonly unknown[] = []
  let result: string[] = []
  return (state: AppState): string[] => {
    const inputs = [
      state.unifiedTabsByWorktree[worktreeId],
      state.tabsByWorktree[worktreeId],
      state.browserTabsByWorktree[worktreeId],
      state.agentStatusByPaneKey,
      state.agentStatusEpoch,
      state.migrationUnsupportedByPtyId,
      state.ptyIdsByTabId,
      state.runtimePaneTitlesByTabId,
      state.terminalLayoutsByTabId,
      state.sortBy,
      state.sortBy === 'smart'
        ? getIndexedWorktreesById(selectWorktreesByRepo(state), worktreeId)[0]?.lastActivityAt
        : undefined
    ]
    if (!inputs.every((value, index) => value === previous[index])) {
      previous = inputs
      result = selectWorktreeLeadingTabs(state, worktreeId)
    }
    return result
  }
}
