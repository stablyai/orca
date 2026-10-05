import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../../shared/jira-types'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../../shared/telemetry-events'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { TaskResumeState, TopLevelView } from '../../../../../shared/ui-chrome-types'

export type PendingSidebarWorktreeReveal = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  behavior: 'auto' | 'smooth'
  highlight?: boolean
  beginRename?: boolean
}

export type PendingSidebarRowReveal = {
  rowKey: string
  behavior: 'auto' | 'smooth'
  highlight?: boolean
}

/** A sidebar subagent row asking its parent's native chat to open that subagent's section. */
export type PendingNativeChatSubagentReveal = {
  parentPaneKey: string
  /** The subagent's provider id: the journal `agentId` its transcript rows carry. */
  agentId: string
}

/** The subagent a terminal pane shows instead of its own agent; absent shows the main agent. */
export type PaneSubagentView = {
  /** The Claude hook agent id: its transcript is `subagents/agent-<agentId>.jsonl`. */
  agentId: string
  /** Kept from the sidebar row, which disappears once the subagent finishes. */
  name: string
  /** The parent session this subagent belongs to; a pane that has since moved to another
   *  session no longer shows it. */
  parentTranscriptPath: string
}

export type AgentSendPopoverTargetMode = {
  id: string
  instanceId: string
  worktreeId: string
  source: 'diff-notes' | 'browser-annotations'
  prompt: string
  label: string
  launchSource: LaunchSource
  eligiblePaneKeys: string[]
  disabledPaneKeys: Record<string, string>
  status: 'open' | 'sending' | 'error'
  sendingPaneKey?: string
  error?: string
  onPromptDelivered?: () => void
  /** Told the send's own result the moment the prompt is handed to an agent. */
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
}

export type OpenAgentSendPopoverTargetModeArgs = {
  id: string
  worktreeId: string
  source: AgentSendPopoverTargetMode['source']
  prompt: string
  label: string
  launchSource: LaunchSource
  onPromptDelivered?: () => void
  onPromptHandedOff?: (delivered: Promise<unknown>) => void
}

export type TaskPageData = {
  preselectedRepoId?: string
  prefilledName?: string
  taskSource?: TaskProvider
  openGitHubWorkItem?: GitHubWorkItem
  openGitHubSourceContext?: TaskSourceContext | null
  openGitHubInitialTab?: 'conversation' | 'checks' | 'files'
  openGitLabWorkItem?: GitLabWorkItem
  openGitLabSourceContext?: TaskSourceContext | null
  openLinearIssue?: LinearIssue
  openLinearSourceContext?: TaskSourceContext | null
  openJiraIssue?: JiraIssue
  openJiraSourceContext?: TaskSourceContext | null
}

export type NewWorkspaceDraft = {
  repoId: string | null
  // Why: project-first creation uses these when present; old drafts keep using only repoId during the additive migration.
  projectId?: string | null
  projectGroupId?: string | null
  hostId?: ExecutionHostId | null
  projectHostSetupId?: string | null
  name: string
  prompt: string
  note: string
  attachments: string[]
  linkedWorkItem: {
    provider?: 'github' | 'gitlab' | 'linear' | 'jira'
    type: 'issue' | 'pr' | 'mr'
    number: number
    title: string
    url: string
    linearIdentifier?: string
    linearBranchName?: string
    jiraIdentifier?: string
    repoId?: string
  } | null
  /** Preserve where provider data came from, separately from the host chosen to run the workspace. */
  taskSourceContext?: TaskSourceContext | null
  linkedTaskSourceContext?: TaskSourceContext | null
  agent: TuiAgent
  linkedIssue: string
  linkedPR: number | null
  /** GitLab parallels — number for an issue, iid for an MR. Optional so pre-GitLab drafts still load without migration. */
  linkedGitLabIssue?: number | null
  linkedGitLabMR?: number | null
  // Why: repo-scoped start ref from the "Start from" picker; absent means "use the repo's effective base ref".
  baseBranch?: string
  // Why: false when `baseBranch` came from the base-ref picker rather than a branch pick, so restoring the
  // draft doesn't turn it back into a name-field pill. Absent on pre-flag drafts, which restore as a pick.
  baseBranchNamesWorkspace?: boolean
  // Why: review worktrees start from a head ref/SHA while Source Control compares against the provider target branch.
  compareBaseRef?: string
}

export type UiViewHistory =
  | 'terminal'
  | 'settings'
  | 'tasks'
  | 'activity'
  | 'automations'
  | 'space'
  | 'skills'
  | 'artifacts'
  | 'mobile'

export type UISliceCore = {
  sidebarOpen: boolean
  sidebarWidth: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  agentSendPopoverTargetMode: AgentSendPopoverTargetMode | null
  openAgentSendPopoverTargetMode: (args: OpenAgentSendPopoverTargetModeArgs) => void
  closeAgentSendPopoverTargetMode: (id?: string, instanceId?: string) => void
  sendPromptToSidebarAgentTarget: (paneKey: string) => Promise<boolean>
  /** Bumped to ask the active worktree's Source Control notes send menu to open (keyboard shortcut). `issuedAt` bounds staleness so a request the menu never consumed can't reopen it much later. */
  diffNotesSendMenuOpenRequest: { worktreeId: string; nonce: number; issuedAt: number } | null
  /** Reveal Source Control and request its notes send menu open; returns false (no-op) when the active worktree has no unsent notes. */
  openDiffNotesSendMenuForActiveWorktree: () => boolean
  consumeDiffNotesSendMenuOpenRequest: (worktreeId: string) => void
  /** Per-agent "I've looked at this" timestamps (paneKey → ts). A row is unvisited when no ack exists or stateStartedAt is newer than the last ack. Persisted so visited rows don't return bold on relaunch. */
  acknowledgedAgentsByPaneKey: Record<string, number>
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  /** Per-pane cutoffs used to hide activity entries cleared by the user. */
  activityClearedAtByPaneKey: Record<string, number>
  applyActivityClearedAt: (patch: Record<string, number | null>) => void
  /** Session-local protection for turns explicitly marked unread. */
  manuallyUnreadTurnsByPaneKey: Record<string, number>
  clearManuallyUnreadTurns: (paneKeys: string[]) => void
  activeView: TopLevelView
  previousViewBeforeTasks: Exclude<UiViewHistory, 'tasks'>
  previousViewBeforeSettings: Exclude<UiViewHistory, 'settings'>
  previousViewBeforeActivity: Exclude<UiViewHistory, 'activity'>
  previousViewBeforeAutomations: Exclude<UiViewHistory, 'automations'>
  previousViewBeforeSpace: Exclude<UiViewHistory, 'space'>
  previousViewBeforeSkills: Exclude<UiViewHistory, 'skills'>
  previousViewBeforeMobile: Exclude<UiViewHistory, 'mobile'>
  previousViewBeforeArtifacts: Exclude<UiViewHistory, 'artifacts'>
  setActiveView: (view: UISliceCore['activeView']) => void
  taskPageData: TaskPageData
  taskResumeState: TaskResumeState | undefined
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  taskListPosition: { contextKey: string; page: number; scrollTop: number } | null
  setTaskListPosition: (position: UISliceCore['taskListPosition']) => void
  githubTaskDrawerWorkItem: GitHubWorkItem | null
  setGithubTaskDrawerWorkItem: (item: GitHubWorkItem | null) => void
  newWorkspaceDraft: NewWorkspaceDraft | null
  openTaskPage: (
    data?: UISliceCore['taskPageData'],
    options?: { recordTasksInteraction?: boolean }
  ) => void
  closeTaskPage: () => void
  openActivityPage: () => void
  closeActivityPage: () => void
  selectedAutomationId: string | null
  setSelectedAutomationId: (id: string | null) => void
  pendingAutomationRunNavigation: {
    automationId: string
    runId: string | null
    hostId?: ExecutionHostId
  } | null
  setPendingAutomationRunNavigation: (
    navigation: { automationId: string; runId: string | null; hostId?: ExecutionHostId } | null
  ) => void
  openAutomationsPage: () => void
  closeAutomationsPage: () => void
  openSpacePage: () => void
  closeSpacePage: () => void
  openSkillsPage: () => void
  closeSkillsPage: () => void
  pendingSkillShareId: string | null
  openSkillShare: (shareId: string) => void
  clearPendingSkillShare: () => void
  /** Set when another surface links straight to the page's shared-links view. */
  pendingSkillsSharedView: boolean
  openSkillsSharedLinks: () => void
  clearPendingSkillsSharedView: () => void
  openArtifactsPage: () => void
  closeArtifactsPage: () => void
  openMobilePage: () => void
  closeMobilePage: () => void
  setNewWorkspaceDraft: (draft: NonNullable<UISliceCore['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  pendingRevealSidebarRow: PendingSidebarRowReveal | null
  pendingNativeChatSubagentReveal: PendingNativeChatSubagentReveal | null
  revealNativeChatSubagent: (reveal: PendingNativeChatSubagentReveal) => void
  clearPendingNativeChatSubagentReveal: () => void
  paneSubagentViewByPaneKey: Record<string, PaneSubagentView>
  showPaneSubagent: (
    paneKey: string,
    subagent: Omit<PaneSubagentView, 'parentTranscriptPath'>
  ) => void
  showPaneMainAgent: (paneKey: string) => void
  /** Back to the main agent in every pane of a terminal tab. */
  showTabMainAgents: (terminalTabId: string) => void
  revealWorktreeInSidebar: (
    worktreeId: string,
    options?: {
      behavior?: PendingSidebarWorktreeReveal['behavior']
      highlight?: boolean
      beginRename?: boolean
      executionHostId?: ExecutionHostId
    }
  ) => void
  revealSidebarRow: (
    rowKey: string,
    options?: {
      behavior?: PendingSidebarRowReveal['behavior']
      highlight?: boolean
    }
  ) => void
}

export type UISliceSet = Parameters<StateCreator<AppState, [], [], UISliceCore>>[0]
export type UISliceGet = Parameters<StateCreator<AppState, [], [], UISliceCore>>[1]
