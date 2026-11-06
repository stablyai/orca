import type { PersistedUIState } from '../persisted-ui-state-types'
import type {
  AgentActivityDisplayMode,
  ProjectOrderBy,
  WorktreeCardProperty
} from '../ui-chrome-types'

// Every surface renders an exhaustive option-key table. Desktop localizes these English labels; tests check parity.

export type WorkspaceGroupBy = PersistedUIState['groupBy']
export type WorkspaceSortBy = PersistedUIState['sortBy']

export type WorkspaceViewChoice<Id extends string> = {
  id: Id
  label: string
  description?: string
}

export const WORKSPACE_GROUP_BY_CHOICES = [
  { id: 'none', label: 'None' },
  { id: 'workspace-status', label: 'Status' },
  { id: 'pr-status', label: 'PR' },
  { id: 'repo', label: 'Project' }
] as const satisfies readonly WorkspaceViewChoice<PersistedUIState['groupBy']>[]

export const WORKSPACE_SORT_BY_CHOICES = [
  { id: 'name', label: 'Name' },
  {
    id: 'smart',
    label: 'Agent Activity',
    description: 'Agents that need attention, then most recent activity.'
  },
  { id: 'recent', label: 'Recent' },
  { id: 'repo', label: 'Project' },
  {
    id: 'manual',
    label: 'Manual',
    description: 'Drag workspaces to arrange them within each group.'
  }
] as const satisfies readonly WorkspaceViewChoice<PersistedUIState['sortBy']>[]

export const WORKSPACE_PROJECT_ORDER_CHOICES = [
  { id: 'manual', label: 'Manual', description: 'Drag projects to arrange them' },
  { id: 'recent', label: 'Recent', description: 'Most recently opened by you' },
  { id: 'frequent', label: 'Frequent', description: 'Most project openings by you' },
  { id: 'name', label: 'Name', description: 'Project name, A to Z' }
] as const satisfies readonly WorkspaceViewChoice<ProjectOrderBy>[]

/** Card layout is the `compactWorktreeCards` setting, not UI state. */
export const WORKSPACE_CARD_LAYOUT_CHOICES = [
  { id: 'detailed', label: 'Detailed' },
  { id: 'compact', label: 'Compact' }
] as const satisfies readonly WorkspaceViewChoice<string>[]

export const WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES = [
  { id: 'compact', label: 'Compact' },
  { id: 'full', label: 'Full list' }
] as const satisfies readonly WorkspaceViewChoice<AgentActivityDisplayMode>[]

/** "Show properties": one card property per row. */
export const WORKSPACE_CARD_PROPERTY_CHOICES = [
  { id: 'issue', label: 'GitHub ticket' },
  { id: 'linear-issue', label: 'Linear issue' },
  { id: 'jira-issue', label: 'Jira issue' },
  { id: 'pr', label: 'PR/MR link' },
  { id: 'automation', label: 'Automation' },
  { id: 'comment', label: 'Notes' },
  { id: 'ports', label: 'Ports' },
  { id: 'inline-agents', label: 'Agent activity' },
  { id: 'host', label: 'Host' }
] as const satisfies readonly WorkspaceViewChoice<WorktreeCardProperty>[]

/** "Card display" (the experimental card style). */
export const WORKSPACE_CARD_DISPLAY_CHOICES = [
  { id: 'issue', label: 'GitHub issues' },
  { id: 'linear-issue', label: 'Linear issues' },
  { id: 'jira-issue', label: 'Jira issues' },
  { id: 'comment', label: 'Notes' },
  { id: 'automation', label: 'Automation' },
  { id: 'cli', label: 'Orca CLI' },
  { id: 'ports', label: 'Ports' },
  { id: 'inline-agents', label: 'Agent statuses' },
  { id: 'host', label: 'Host' },
  { id: 'branch', label: 'Branch name' }
] as const satisfies readonly WorkspaceViewChoice<WorktreeCardProperty>[]

/** Return "hover" for compact properties, otherwise the shown count or null for none. */
export function getWorkspaceCardPropertiesValue(
  shownProperties: readonly string[],
  compactWorktreeCards: boolean
): 'hover' | number | null {
  if (compactWorktreeCards) {
    return 'hover'
  }
  const count = WORKSPACE_CARD_PROPERTY_CHOICES.filter((choice) =>
    shownProperties.includes(choice.id)
  ).length
  return count > 0 ? count : null
}

/** Project groups can hold folder workspaces, whose identity is a path, not a branch. */
export function getWorkspaceCardDisplayChoiceLabel(
  choice: (typeof WORKSPACE_CARD_DISPLAY_CHOICES)[number],
  hasProjectGroups: boolean
): string {
  return choice.id === 'branch' && hasProjectGroups ? 'Branch / folder path' : choice.label
}

export type WorkspaceViewSection = 'show' | 'group' | 'arrange' | 'filters'

export const WORKSPACE_VIEW_SECTION_LABELS: Record<WorkspaceViewSection, string | null> = {
  show: 'Show',
  group: 'Group by',
  arrange: null,
  filters: 'Filters'
}

export const WORKSPACE_VIEW_OPTIONS = [
  { key: 'hosts', section: 'show', label: 'Hosts' },
  { key: 'projects', section: 'show', label: 'Projects' },
  { key: 'groupBy', section: 'group', label: 'Group by' },
  { key: 'sortBy', section: 'arrange', label: 'Sort by' },
  { key: 'projectOrderBy', section: 'arrange', label: 'Project order' },
  { key: 'cardLayout', section: 'arrange', label: 'Card layout' },
  // Also holds the agent activity layout choice.
  { key: 'cardProperties', section: 'arrange', label: 'Show properties' },
  { key: 'cardDisplay', section: 'arrange', label: 'Card display' },
  { key: 'hideSleepingWorkspaces', section: 'filters', label: 'Hide sleeping' },
  {
    key: 'alwaysShowDefaultBranchWorkspace',
    section: 'filters',
    label: 'Except default branch'
  },
  { key: 'hideDefaultBranchWorkspace', section: 'filters', label: 'Hide default branch' },
  {
    key: 'hideAutomationGeneratedWorkspaces',
    section: 'filters',
    label: 'Hide automation-created'
  },
  { key: 'hideCliCreatedWorkspaces', section: 'filters', label: 'Hide CLI-created' },
  {
    key: 'hideWorkspacesFromOtherDevices',
    section: 'filters',
    label: 'Hide other-client workspaces'
  },
  { key: 'hideDetachedHeadWorkspaces', section: 'filters', label: 'Hide detached HEAD' }
] as const satisfies readonly { key: string; section: WorkspaceViewSection; label: string }[]

export type WorkspaceViewOption = (typeof WORKSPACE_VIEW_OPTIONS)[number]
export type WorkspaceViewOptionKey = WorkspaceViewOption['key']

export type WorkspaceViewOptionContext = {
  groupBy: PersistedUIState['groupBy']
  hideSleepingWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  newCardStyle: boolean
  /** Any host besides this machine; the host picker has nothing to choose otherwise. */
  hasRemoteHosts: boolean
  projectCount: number
  /** Paired servers exist, or might: other-client workspaces only come from shared servers. */
  mayHaveServerHosts: boolean
}

const SHOWN: Record<WorkspaceViewOptionKey, (context: WorkspaceViewOptionContext) => boolean> = {
  hosts: (context) => context.hasRemoteHosts,
  projects: (context) => context.projectCount > 1,
  groupBy: () => true,
  sortBy: () => true,
  projectOrderBy: (context) => context.groupBy === 'repo',
  cardLayout: (context) => !context.newCardStyle,
  cardProperties: (context) => !context.newCardStyle,
  cardDisplay: (context) => context.newCardStyle,
  hideSleepingWorkspaces: () => true,
  // Why: the exemption only bites while sleeping workspaces are being swept.
  alwaysShowDefaultBranchWorkspace: (context) => context.hideSleepingWorkspaces,
  hideDefaultBranchWorkspace: () => true,
  hideAutomationGeneratedWorkspaces: () => true,
  hideCliCreatedWorkspaces: () => true,
  // Why the current value: an active filter must stay reachable to turn it off.
  hideWorkspacesFromOtherDevices: (context) =>
    context.mayHaveServerHosts || context.hideWorkspacesFromOtherDevices,
  hideDetachedHeadWorkspaces: () => true
}

/** The options a surface renders now, grouped by section in menu order; empty sections are dropped. */
export function getShownWorkspaceViewSections(
  context: WorkspaceViewOptionContext
): { section: WorkspaceViewSection; options: WorkspaceViewOption[] }[] {
  const sections: { section: WorkspaceViewSection; options: WorkspaceViewOption[] }[] = []
  for (const option of WORKSPACE_VIEW_OPTIONS) {
    if (!SHOWN[option.key](context)) {
      continue
    }
    const last = sections.at(-1)
    if (last?.section === option.section) {
      last.options.push(option)
    } else {
      sections.push({ section: option.section, options: [option] })
    }
  }
  return sections
}
