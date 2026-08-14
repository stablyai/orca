/**
 * Public barrel for Orca's shared domain types. Declarations live in the
 * per-domain modules re-exported below; keep this file re-exports only.
 */

// Repos, projects, and project groups

export type { RepoKind, IssueSourcePreference, ExternalWorktreeVisibility } from './repo-types'
export type { BuiltInWorktreeVisibilitySourceId } from './repo-types'
export type { CustomWorktreeVisibilitySource } from './repo-types'
export type { WorktreeVisibilitySourcePreferences, Repo, BaseRefDefaultResult } from './repo-types'
export type { BaseRefSearchResult } from './repo-types'

export type { ForkSyncMode, GitForkSyncExpectedUpstream, GitForkSyncResult } from './git-fork-sync'

export type { ProjectProviderIdentity, Project, ProjectUpdateArgs } from './project-types'
export type { ProjectHostSetupState, ProjectHostSetupMethod } from './project-types'
export type { RepoProjectHostSetupMethod, ProjectHostSetup } from './project-types'
export type { ProjectHostSetupExistingFolderArgs } from './project-types'
export type { ProjectHostSetupCreateArgs, ProjectHostSetupCloneArgs } from './project-types'
export type { ProjectHostSetupUpdateArgs, ProjectHostSetupDeleteArgs } from './project-types'
export type { ProjectHostSetupResult, ProjectHostSetupCreateResult } from './project-types'
export type { ProjectHostSetupUpdateResult, ProjectHostSetupDeleteResult } from './project-types'

export type { ProjectGroupCreatedFrom, ProjectGroup } from './project-group-types'
export type { NestedRepoScanOptions, NestedRepoCandidate } from './project-group-types'
export type { NestedRepoScanResult, ProjectGroupImportMode } from './project-group-types'
export type { ProjectGroupImportProjectResult } from './project-group-types'
export type { ProjectGroupImportResult } from './project-group-types'

export type { WorkspaceScope, WorkspaceKey, FolderWorkspace } from './folder-workspace-types'
export type { FolderWorkspaceLinkedTask } from './folder-workspace-types'

// Worktrees and workspace session state

export type { GitWorktreeInfo, WorktreeHeadIdentity, WorkspaceStatus } from './worktree-types'
export type { WorkspaceStatusDefinition, Worktree, WorkspaceLinkedItem } from './worktree-types'
export type { CliWorkspaceProvenance, WorkspaceCreatorProvenance } from './worktree-types'
export type { AutomationWorkspaceProvenance } from './worktree-types'
export type { AutomationWorkspaceProvenanceRequest, GitPushTarget } from './worktree-types'
export type { GitHubPrStartPoint, WorktreeOwnership } from './worktree-types'
export type { DetectedWorktreeListSource, DetectedWorktree } from './worktree-types'
export type { DetectedWorktreeListResult } from './worktree-types'

export type { WorktreeMeta } from './worktree-meta-types'

export type { WorktreeLineageOrigin } from './worktree-lineage-types'
export type { WorktreeLineageCaptureConfidence } from './worktree-lineage-types'
export type { WorktreeLineageCaptureSource, WorktreeLineageCapture } from './worktree-lineage-types'
export type { WorktreeLineage, WorkspaceLineage } from './worktree-lineage-types'
export type { WorktreeLineageWarningCode, WorktreeLineageWarning } from './worktree-lineage-types'

export type { WorktreeSetupLaunch, WorktreeStartupLaunch } from './worktree-launch-types'
export type { WorktreeDefaultTabsLaunch, SetupScriptLaunchMode } from './worktree-launch-types'
export type { SetupSplitDirection } from './worktree-launch-types'

export type { SetupDecision, WorktreeCreateTimingPhase } from './worktree-create-types'
export type { WorktreeCreateTiming, CreateSparseCheckoutRequest } from './worktree-create-types'
export type { SparsePreset, CreateWorktreeArgs } from './worktree-create-types'
export type { AdoptProvisionedRootArgs, CreateWorktreeResult } from './worktree-create-types'
export type { WorktreeCreateBaseFallback, PreservedWorktreeBranch } from './worktree-create-types'
export type { RemoveWorktreeResult, ForceDeleteWorktreeBranchResult } from './worktree-create-types'

export type { LocalBaseRefRefreshResult } from './worktree-base-ref-drift-types'
export type { LocalBaseRefUpdateSuggestion } from './worktree-base-ref-drift-types'
export type { WorktreeBaseStatusKind } from './worktree-base-ref-drift-types'
export type { WorktreeBaseStatusEvent } from './worktree-base-ref-drift-types'
export type { WorktreeRemoteBranchConflictEvent } from './worktree-base-ref-drift-types'

export type { PersistedOpenFile, WorkspaceSessionState } from './workspace-session-state-types'
export type { WorkspaceSessionPatch } from './workspace-session-state-types'

// Re-exported for backward compat with renderer call sites that import
// `WorkspaceCreateTelemetrySource` from '../../../shared/types'.
export type { WorkspaceSource as WorkspaceCreateTelemetrySource } from './workspace-source'

// Tabs, terminals, and the embedded browser

export type { TabGroupSplitDirection, TabGroupLayoutNode, TabContentType } from './tab-types'
export type { WorkspaceVisibleTabType, CtrlTabOrderMode, Tab, TabGroup } from './tab-types'

export type { TerminalTab, TerminalPaneSplitDirection } from './terminal-tab-types'
export type { TerminalPaneLayoutNode, TerminalLayoutSnapshot } from './terminal-tab-types'

export type { TerminalColorOverrides } from './terminal-color-overrides'

export type { TerminalQuickCommandScope } from './terminal-quick-command-types'
export type { TerminalQuickCommandAction } from './terminal-quick-command-types'
export type { TerminalQuickCommandBase } from './terminal-quick-command-types'
export type { TerminalCommandQuickCommand } from './terminal-quick-command-types'
export type { TerminalAgentQuickCommand } from './terminal-quick-command-types'
export type { TerminalQuickCommand } from './terminal-quick-command-types'

export type { BrowserHistoryEntry, BrowserLoadError } from './browser-workspace-types'
export type { BrowserCertificateFailure } from './browser-workspace-types'
export type { BrowserCertificateProceedFailureReason } from './browser-workspace-types'
export type { BrowserCertificateProceedResult } from './browser-workspace-types'
export type { BrowserViewportPresetId, BrowserViewportOverride } from './browser-workspace-types'
export type { BrowserPage, BrowserWorkspace, BrowserTab } from './browser-workspace-types'
export type { BrowserSessionProfileScope } from './browser-workspace-types'
export type { BrowserSessionUserAgentMode } from './browser-workspace-types'
export type { BrowserSessionProfileCreateOptions } from './browser-workspace-types'
export type { BrowserSessionProfileSource, BrowserSessionProfile } from './browser-workspace-types'
export type { BrowserCookieImportSummary } from './browser-workspace-types'
export type { BrowserCookieImportResult } from './browser-workspace-types'

// Git status, diffs, and review comments

export type {
  GitBranchChangeStatus,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GitFileStatus,
  GitStagingArea,
  GitStatusEntry,
  GitStatusResult,
  GitSubmoduleStatus,
  GitUncommittedEntry,
  GitUpstreamStatus
} from './git-status-types'

export type { GitBranchChangeEntry, GitBranchCompareSummary } from './git-diff-compare-types'
export type { GitBranchCompareResult, GitCommitCompareSummary } from './git-diff-compare-types'
export type { GitCommitCompareResult, GitDiffTextResult } from './git-diff-compare-types'
export type { GitDiffBinaryResult, GitDiffResult } from './git-diff-compare-types'

export type { DiffCommentSource, DiffReviewScope } from './diff-comment-types'
export type { MobileDiffReviewFileState, MobileDiffReviewState } from './diff-comment-types'
export type { DiffComment } from './diff-comment-types'

// GitHub

export type { PRState, IssueState, CheckStatus, PRMergeableState } from './github-pr-types'
export type { PRReviewDecision, PRConflictSummary } from './github-pr-types'
export type { GitHubRepositoryIdentity, GitHubOwnerRepo } from './github-pr-types'
export type { GitHubPRMergeMethod, GitHubPRMergeMethodSettings } from './github-pr-types'
export type { GitHubPRStackEntry, GitHubPRStack, PRInfo, IssueInfo } from './github-pr-types'
export type { GitHubViewer, GitHubAssignableUser, ProviderCheckSummary } from './github-pr-types'
export type { GitHubPRReviewSummary, GitHubPRFileViewedState } from './github-pr-types'
export type { GitHubPRFile, GitHubPRFileContents } from './github-pr-types'

export type { PRRefreshErrorType, PRRefreshUpstreamErrorType } from './github-pr-refresh-types'
export type { PRRefreshOutcome, GitHubPRRefreshReason } from './github-pr-refresh-types'
export type { GitHubPRRefreshEnqueueResult, GitHubPRRefreshAlias } from './github-pr-refresh-types'
export type { GitHubPRRefreshCandidate } from './github-pr-refresh-types'
export type { GitHubPRRefreshSkippedReason, GitHubPRRefreshEvent } from './github-pr-refresh-types'

export type { PRCheckDetail, PRCheckAnnotation, PRCheckStep } from './github-check-types'
export type { PRCheckJob, PRCheckRunDetails, GitHubRerunPRChecksResult } from './github-check-types'

export type { GitHubReactionContent, GitHubReaction, PRComment } from './github-comment-types'
export type { GitHubCommentResult, GitHubPRReviewCommentInput } from './github-comment-types'
export type { GitHubIssueTimelineTarget, GitHubIssueTimelineItem } from './github-comment-types'

export type { GitHubWorkItem, GitHubWorkItemDetails } from './github-work-item-types'
export type { ListWorkItemsResult } from './github-work-item-types'

export type { GitHubRateLimitBucket, GitHubRateLimitSnapshot } from './github-rate-limit-types'
export type { GetRateLimitResult } from './github-rate-limit-types'

// GitLab

export type {
  GitLabAssignableUser,
  GitLabAuthDiagnostic,
  GitLabCommentResult,
  GitLabDiscussionResolveResult,
  GitLabIssueInfo,
  GitLabIssueState,
  GitLabIssueUpdate,
  GitLabJobTraceResult,
  GitLabRateLimitBucket,
  GitLabRateLimitSnapshot,
  GitLabMRApprovalRule,
  GitLabMRApprovalState,
  GitLabMRFile,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  GitLabMRUpdate,
  GitLabPagedResult,
  GitLabPipelineJob,
  GitLabProjectRef,
  GitLabProjectSettings,
  GitLabRetryJobResult,
  GitLabReaction,
  GitLabTodo,
  GitLabTodoTargetType,
  GitLabViewer,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  GetGitLabRateLimitResult,
  ListMergeRequestsResult,
  MRCheckDetail,
  MRComment,
  MRInfo,
  MRListState,
  MRMergeableState,
  MRState
} from './gitlab-types'

// Jira

export type {
  JiraAuthType,
  JiraComment,
  JiraConnectArgs,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateFieldAllowedValue,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraProjectStatusOrder,
  JiraSite,
  JiraSiteSelection,
  JiraStatus,
  JiraTransition,
  JiraUser,
  JiraViewer
} from './jira-types'

// Linear

export type { LinearViewer, LinearWorkspace } from './linear-workspace-types'
export type { LinearWorkspaceSelection, LinearWorkspaceSelector } from './linear-workspace-types'
export type { LinearConcreteWorkspaceId, LinearWorkspaceError } from './linear-workspace-types'
export type { LinearCollectionResult, LinearConnectionStatus } from './linear-workspace-types'
export type { LinearWorkflowState, LinearLabel, LinearMember } from './linear-workspace-types'
export type { LinearTeam } from './linear-workspace-types'

export type { LinearIssue, LinearIssueChildSummary, LinearComment } from './linear-issue-types'

export type { LinearProjectSummary, LinearProjectStatusSummary } from './linear-project-types'
export type { LinearProjectMemberSummary } from './linear-project-types'
export type { LinearProjectMilestoneSummary } from './linear-project-types'
export type { LinearProjectResourceSummary } from './linear-project-types'
export type { LinearProjectUpdateSummary, LinearProjectDetail } from './linear-project-types'
export type { LinearCustomViewModel, LinearCustomViewSummary } from './linear-project-types'

// Cross-provider issue mutations and task sources

export type { GitHubCreateIssueFields, GitHubCreateIssueResult } from './issue-mutation-types'
export type { GitHubIssueCloseReason, GitHubIssueUpdate } from './issue-mutation-types'
export type { GitHubPullRequestStateUpdate, LinearIssueUpdate } from './issue-mutation-types'

export type { TaskProvider } from './task-providers'

// orca.yaml hooks, setup policy, and VM recipes

export type { OrcaHooks, OrcaWorktreeDefaults } from './orca-yaml-hook-types'
export type { OrcaDefaultTabTemplate, EphemeralVmCheckoutMode } from './orca-yaml-hook-types'
export type { OrcaVmRecipe, OrcaVmRecipeDiagnostic, RepoHookSettings } from './orca-yaml-hook-types'
export type { SetupRunPolicy, SetupAgentStartupPolicy } from './orca-yaml-hook-types'
export type { HookCommandSourcePolicy, PersistedTrustedOrcaHookEntry } from './orca-yaml-hook-types'
export type { PersistedTrustedOrcaHookRepo } from './orca-yaml-hook-types'
export type { PersistedTrustedOrcaHooks } from './orca-yaml-hook-types'

// Settings, persisted UI state, and onboarding

export type { TaskViewPresetId, OpenInApplication, SourceControlViewMode } from './ui-chrome-types'
export type { SourceControlGroupOrder, LeftSidebarAppearanceMode } from './ui-chrome-types'
export type { BranchPrefixStrategy, FloatingTerminalCwdRequest } from './ui-chrome-types'
export type { AgentDashboardMode, WorktreeCardProperty, WorktreeCardMode } from './ui-chrome-types'
export type { AgentActivityDisplayMode, StatusBarItem } from './ui-chrome-types'
export type { FloatingTerminalTriggerLocation, TaskResumeState } from './ui-chrome-types'
export type { RightSidebarTab, ActiveRightSidebarTab } from './ui-chrome-types'
export type { RightSidebarExplorerView, ProjectOrderBy } from './ui-chrome-types'
export type { WorkspaceHostScope, VisibleWorkspaceHostIds } from './ui-chrome-types'
export type { WorkspaceHostOrder, ManualRepoOrderEntry, TopLevelView } from './ui-chrome-types'

export type { GlobalSettings, OrcaWorkspaceLayout } from './global-settings-types'
export type { GhosttyImportPreview } from './global-settings-types'

export type { HostSettingOverrides } from './host-setting-overrides'

export type { CommitMessageAiModelCapability } from './commit-message-ai-types'
export type { CommitMessageAiSettings } from './commit-message-ai-types'

export type { NotificationSettings, NotificationEventSource } from './notification-settings-types'
export type { NotificationDispatchRequest } from './notification-settings-types'
export type { NotificationDispatchResult } from './notification-settings-types'
export type { NotificationDismissResult } from './notification-settings-types'
export type { NotificationSoundResult } from './notification-settings-types'
export type { NotificationSoundDataResult } from './notification-settings-types'
export type { NotificationSoundPathResult } from './notification-settings-types'
export type { NotificationPermissionStatusResult } from './notification-settings-types'
export type { NotificationDeliveryProbeResult } from './notification-settings-types'

export type { DiscoveryStatusEmitted, OnboardingOutcome } from './onboarding-state-types'
export type { OnboardingChecklistState, OnboardingState } from './onboarding-state-types'

export type { PersistedUIState } from './persisted-ui-state-types'

export type { LegacyPaneKeyAliasEntry } from './persisted-state-types'
export type { PersistedMobileClientTabSelection } from './persisted-state-types'
export type { PersistedMobileClientTabSelections, PersistedState } from './persisted-state-types'

export { PET_SIZE_MIN, PET_SIZE_MAX, PET_SIZE_DEFAULT } from './pet-types'
export type { CustomPet, SpriteAnimation } from './pet-types'

// Agents, managed accounts, and updates

export type { TuiAgent } from './tui-agent'

export type { CodexManagedAccount, CodexManagedAccountSummary } from './managed-account-types'
export type { CodexSystemDefaultIdentity } from './managed-account-types'
export type { CodexRateLimitAccountsState } from './managed-account-types'
export type { CodexManagedAccountRuntimeSelection } from './managed-account-types'
export type { ClaudeManagedAccount, ClaudeManagedAccountSummary } from './managed-account-types'
export type { ClaudeRateLimitAccountsState } from './managed-account-types'
export type { ClaudeManagedAccountRuntimeSelection } from './managed-account-types'

export type { ChangelogRelease, ChangelogData, UpdateCheckOptions } from './update-status-types'
export type { UpdateSource, LinuxRootPackageType } from './update-status-types'
export type { LinuxPackageInstallFailureReason } from './update-status-types'
export type { LinuxPackageInstallRecovery } from './update-status-types'
export type { LinuxPackageCommandUnavailableReason } from './update-status-types'
export type { LinuxPackageInstallInstructions, UpdateStatus } from './update-status-types'
export type { ReleaseBuildListResult } from './update-status-types'

// Filesystem, search, process stats, and shared error shape

export type { ShellHydrationFailureReason, PathSource } from './shell-path-hydration-types'

export type { FilesystemPathFlavor, DirEntry, MarkdownDocument } from './filesystem-entry-types'
export type { FsChangeEvent, FsChangedPayload } from './filesystem-entry-types'

export type { SearchMatch, SearchFileResult, SearchResult } from './code-search-types'
export type { SearchOptions } from './code-search-types'

export type { StatsSummary, UsageValues, ProcessMemoryMetric } from './process-stats-types'
export type { HostAvailableMemorySource, AppMemory, SessionMemory } from './process-stats-types'
export type { WorktreeMemory, HostMemory, MemorySnapshot } from './process-stats-types'

export type { ClassifiedError } from './classified-error'
