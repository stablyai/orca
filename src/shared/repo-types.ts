import type { RepoIcon } from './repo-icon'
import type { GhAccountBinding } from './github/account-binding'
import type { GitHubRepositoryIdentity } from './github/pull-request-types'
import type { RepoHookSettings } from './orca-yaml-hook-types'
import type { ForkSyncMode } from './git-fork-sync'
import type { GitRemoteIdentity } from './git-remote-identity'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'
import type { RepoProjectHostSetupMethod } from './project-types'
import type { JiraProjectReference } from './jira/jira-project-reference'
import type { OrcadRetainedMarker } from './orcad-retained-marker'

export type RepoKind = 'git' | 'folder'

/** Explicit choices survive remote-topology changes; absent/auto uses upstream when present, otherwise origin.
 * Explicit upstream falls back to origin with a toast if that remote vanishes. */
export type IssueSourcePreference = 'upstream' | 'origin' | 'auto'
export type ExternalWorktreeVisibility = 'hide' | 'show'

export type BuiltInWorktreeVisibilitySourceId = 'claude' | 'gsd'

export type CustomWorktreeVisibilitySource = {
  id: string
  rootPath: string
}

export type WorktreeVisibilitySourcePreferences = {
  builtIn?: Partial<Record<BuiltInWorktreeVisibilitySourceId, ExternalWorktreeVisibility>>
  custom?: Record<string, ExternalWorktreeVisibility>
}

export type WorktreeVisibilityDefaults = {
  /** Default for worktrees outside a recognized source. */
  external?: ExternalWorktreeVisibility
  /** Host-owned roots applied to every repository on that host. */
  customSources?: CustomWorktreeVisibilitySource[]
  /** Defaults for built-in and host-owned custom sources. */
  sourcePreferences?: WorktreeVisibilitySourcePreferences
}

export type Repo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  repoIcon?: RepoIcon | null
  /** Fork parent; same-name forks use its avatar, renamed forks keep their own. Absent means non-fork or unresolved. */
  upstream?: GitHubRepositoryIdentity | null
  addedAt: number
  kind?: RepoKind
  /** Git root proven during folder upgrade; keeps the original checkout locator stable. */
  folderUpgradeGitRootPath?: string
  gitUsername?: string
  worktreeBaseRef?: string
  /** Optional repo-scoped workspace root override. Relative paths resolve from `path`. */
  worktreeBasePath?: string
  hookSettings?: RepoHookSettings
  /** SSH target ID for remote repos. null/undefined = local. */
  connectionId?: string | null
  /** Runtime-host repos otherwise resemble local repos (connectionId: null); retain their explicit execution owner. */
  executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
  /** Absent means auto; writers omit on creation for persisted-record compatibility. */
  issueSourcePreference?: IssueSourcePreference
  /** Host-owned Jira project default; users can override it in each composer. */
  defaultJiraProject?: JiraProjectReference | null
  /** Bind host/login only; resolve a short-lived gh token at spawn and inject into that child’s environment. */
  ghAccount?: GhAccountBinding
  /** Controls Orca's fork-default-branch sync offer for repos with upstream metadata. */
  forkSyncMode?: ForkSyncMode
  /** Canonical identity for the repo remote Orca should use for provider-level grouping. */
  gitRemoteIdentity?: GitRemoteIdentity | null
  /** Controls whether worktrees Orca did not create appear in the sidebar. */
  externalWorktreeVisibility?: ExternalWorktreeVisibility
  /** True when the repo predates hidden-by-default external worktrees. */
  externalWorktreeVisibilityLegacy?: boolean
  /** One-shot guard for the optional existing-user visibility prompt. */
  externalWorktreeVisibilityPromptDismissedAt?: number
  /** Hidden external worktree paths acknowledged by Keep hidden on the inbox. */
  externalWorktreeInboxBaselinePaths?: string[]
  /** External worktree paths explicitly imported while global visibility stays hide. */
  importedExternalWorktreePaths?: string[]
  /** Opt-in repo policy for coding-agent scratch worktrees; absent means hide. */
  agentWorktreeVisibility?: ExternalWorktreeVisibility
  /** User-defined roots classified independently from ordinary external worktrees. */
  customWorktreeVisibilitySources?: CustomWorktreeVisibilitySource[]
  /** Per-source visibility; absent built-ins inherit the legacy agent policy. */
  worktreeVisibilitySourcePreferences?: WorktreeVisibilitySourcePreferences
  /** User permanently opted out of the new-external-worktree inbox for this repo. */
  externalWorktreeDiscoverySuppressedAt?: number
  /** Relative paths to APFS-clone on macOS when possible, otherwise symlink, into new worktrees. Absent/empty creates none. */
  symlinkPaths?: string[]
  /** Durable sidebar-only repo organization. Execution remains repo-scoped. */
  projectGroupId?: string | null
  /** User-authored ordering inside the project group or ungrouped bucket. */
  projectGroupOrder?: number
  /** Repo-specific source-control AI overrides. Missing fields inherit global settings. */
  sourceControlAi?: RepoSourceControlAiOverrides
  /** Transitional source for ProjectHostSetup.setupMethod while Repo remains compatibility storage. */
  projectHostSetupMethod?: RepoProjectHostSetupMethod
  /** Local row a WSL host now owns, kept for a downgrade; set only by the mover's retention pass. */
  orcadRetained?: OrcadRetainedMarker
}

/** Shared IPC shape for repos:getBaseRefDefault across main/preload/renderer; remoteCount avoids a second hint lookup. */
export type BaseRefDefaultResult = {
  defaultBaseRef: string | null
  remoteCount: number
  /** This stopped (or unverifiable) WSL distro refused the read (E9); re-ask once it runs. */
  refusedWslDistro?: string
}

export type BaseRefSearchResult = {
  refName: string
  localBranchName: string
}
