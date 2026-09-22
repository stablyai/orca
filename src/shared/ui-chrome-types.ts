import type { LinearConcreteWorkspaceId } from './linear/workspace-types'
import type { LinearCustomViewModel } from './linear/project-types'

export type TaskViewPresetId = 'all' | 'issues' | 'review' | 'my-issues' | 'my-prs' | 'prs'

export type OpenInApplication = {
  id: string
  label: string
  command: string
}

export type SourceControlViewMode = 'list' | 'tree'
export type SourceControlGroupOrder = 'changes-first' | 'staged-first' | 'untracked-first'

export type LeftSidebarAppearanceMode = 'default' | 'match-terminal' | 'tinted'

/** Strategy for the prefix prepended to worktree branch names. */
export type BranchPrefixStrategy = 'git-username' | 'custom' | 'none'

export type FloatingTerminalCwdRequest = {
  path?: string
  requireTrusted?: boolean
}

/** Presentation mode for the experimental Agent Dashboard. */
export type AgentDashboardMode = 'in-window' | 'popout'

export type WorktreeCardProperty =
  | 'status'
  | 'unread'
  // Legacy persisted preference. CI status is now represented by linked PR metadata.
  | 'ci'
  // Migration-only: legacy detailed cards showed branch identity as a visible row.
  | 'branch'
  // Task metadata on workspace cards; provider-specific persisted values kept for older profiles.
  | 'issue'
  | 'linear-issue'
  | 'jira-issue'
  | 'pr'
  | 'automation'
  // Badge marking workspaces created through `orca worktree create`.
  | 'cli'
  | 'comment'
  | 'ports'
  // Inline agent-activity list rendered in each workspace card; on by default (see DEFAULT_WORKTREE_CARD_PROPERTIES in shared/constants.ts).
  | 'inline-agents'

export type WorktreeCardMode = 'Default' | 'Compact'

export type AgentActivityDisplayMode = 'compact' | 'full'

// Re-exported so existing importers keep one home for UI chrome types; the
// value domain lives with the normalizers that police it.
export type { ActivityGroupBy, ThreadReadFilter } from './agents-view-thread-filters'

export type StatusBarItem =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'opencode-go'
  | 'kimi'
  | 'minimax'
  | 'grok'
  | 'ssh'
  | 'resource-usage'
  | 'ports'
export type FloatingTerminalTriggerLocation = 'floating-button' | 'status-bar'

export type TaskResumeState = {
  githubMode?: 'items' | 'project'
  githubItemsPreset?: TaskViewPresetId | null
  githubItemsQuery?: string
  githubProjectHiddenFieldIdsByView?: Record<string, string[]>
  linearMode?: 'issues' | 'projects' | 'views' | 'in-orca'
  linearPreset?: 'assigned' | 'created' | 'all' | 'completed'
  linearQuery?: string
  linearContext?: {
    kind: 'project' | 'view'
    id: string
    workspaceId: LinearConcreteWorkspaceId
    model?: LinearCustomViewModel
  }
  jiraPreset?: 'assigned' | 'reported' | 'all' | 'done'
  jiraQuery?: string
}

export type RightSidebarTab =
  | 'explorer'
  | 'search'
  | 'vault'
  | 'workspaces'
  | 'pr-checks'
  | 'source-control'
  | 'checks'
  | 'ports'
  // Plugin-contributed panels are keyed `plugin:<pluginId>/<panelId>` so the
  // static union stays closed while plugin tabs remain type-representable.
  | `plugin:${string}`
export type ActiveRightSidebarTab = Exclude<RightSidebarTab, 'search'>
export type RightSidebarExplorerView = 'files' | 'search'

export type ProjectOrderBy = 'manual' | 'recent'
export type WorkspaceHostScope = 'all' | 'local' | `ssh:${string}` | `runtime:${string}`
export type VisibleWorkspaceHostIds = Exclude<WorkspaceHostScope, 'all'>[] | null
export type WorkspaceHostOrder = Exclude<WorkspaceHostScope, 'all'>[]
export type ManualRepoOrderEntry = {
  hostId: WorkspaceHostOrder[number]
  repoId: string
}

/** The active top-level section shown in the main content area. */
export type TopLevelView =
  | 'terminal'
  | 'settings'
  | 'tasks'
  | 'activity'
  | 'automations'
  | 'space'
  | 'skills'
  | 'artifacts'
  | 'mobile'
