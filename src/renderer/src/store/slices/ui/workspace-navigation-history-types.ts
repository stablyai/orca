import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { GitLabWorkItem } from '../../../../../shared/gitlab/gitlab-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { AutomationsPageLocation } from './automations-page-location'

// Why: entries may be page sentinels, not just worktree IDs; names keep the "worktree" prefix for call-site stability.
export type WorktreeNavHistorySimpleViewEntry = 'tasks' | 'automations' | 'artifacts' | 'skills'
export type WorktreeNavHistoryTaskDetailEntry =
  | {
      kind: 'task-detail'
      source: 'github'
      workItem: GitHubWorkItem
      sourceContext?: TaskSourceContext | null
      initialTab?: 'conversation' | 'checks' | 'files'
    }
  | {
      kind: 'task-detail'
      source: 'linear'
      issue: LinearIssue
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'gitlab'
      workItem: GitLabWorkItem
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'jira'
      issue: JiraIssue
      sourceContext?: TaskSourceContext | null
    }
/** One Automations sub-page, so titlebar Back steps through them like any other page. */
export type WorktreeNavHistoryAutomationsPageEntry = {
  kind: 'automations-page'
  location: AutomationsPageLocation
}
export type WorktreeNavHistoryViewEntry =
  | WorktreeNavHistorySimpleViewEntry
  | `plugin:${string}`
  | WorktreeNavHistoryTaskDetailEntry
  | WorktreeNavHistoryAutomationsPageEntry
export type WorktreeNavHistoryEntry = (string & {}) | WorktreeNavHistoryViewEntry

export type WorktreeNavHistorySlice = {
  // Linear history, oldest -> newest.
  worktreeNavHistory: WorktreeNavHistoryEntry[]
  // Index into worktreeNavHistory pointing at the active entry; -1 means empty.
  worktreeNavHistoryIndex: number
  // Why: true during goBack/goForward so recordWorktreeVisit skips re-recording a history-driven navigation.
  isNavigatingHistory: boolean

  recordWorktreeVisit: (worktreeId: string) => void
  recordViewVisit: (entry: WorktreeNavHistoryViewEntry) => void
  goBackWorktree: () => void
  goForwardWorktree: () => void
}
