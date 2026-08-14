import type { RepoIcon } from './repo-icon'
import type { GitHubRepositoryIdentity } from './github/pull-request-types'
import type { RepoHookSettings } from './orca-yaml-hook-types'
import type { ForkSyncMode } from './git-fork-sync'
import type { GitRemoteIdentity } from './git-remote-identity'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'
import type { RepoProjectHostSetupMethod } from './project-types'

// ─── Repo ────────────────────────────────────────────────────────────
export type RepoKind = 'git' | 'folder'

/**
 * Per-repo user choice for where issues are fetched and filed.
 *
 * Why three states, not two: storage must distinguish "user explicitly chose
 * upstream" from "heuristic happens to resolve to upstream right now." Collapsing
 * the two would let a remote-topology change (someone removes `upstream`, or
 * adds one later) silently move the effective source — the exact silent-source-
 * switch class the upstream-issue-source design rejects.
 *
 * - `'auto'` (or undefined): honor the heuristic in `getIssueOwnerRepo`
 *   (upstream-if-exists, else origin). Initial state for every repo.
 * - `'upstream'`: explicit upstream. Wins over heuristic and future topology
 *   changes. Falls back to origin if `upstream` remote vanishes, with a toast.
 * - `'origin'`: explicit origin. Same precedence.
 */
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

export type Repo = {
  id: string
  path: string
  displayName: string
  badgeColor: string
  repoIcon?: RepoIcon | null
  /** Set when the repo is a fork: the upstream/parent owner/repo. Drives the
   *  fork indicator and the default avatar of same-name forks (renamed forks
   *  keep their own owner). Absent = not a fork, or fork status not yet
   *  resolved. */
  upstream?: GitHubRepositoryIdentity | null
  addedAt: number
  kind?: RepoKind
  gitUsername?: string
  worktreeBaseRef?: string
  /** Optional repo-scoped workspace root override. Relative paths resolve from `path`. */
  worktreeBasePath?: string
  hookSettings?: RepoHookSettings
  /** SSH target ID for remote repos. null/undefined = local. */
  connectionId?: string | null
  /**
   * Explicit execution owner for this repo. Runtime-host repos need this
   * because they otherwise look identical to local repos (`connectionId: null`).
   */
  executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
  /** Per-repo override for issue-source resolution. `undefined` is treated
   *  identically to `'auto'`; writers leave it undefined on creation so
   *  existing persisted records stay forward-compatible. */
  issueSourcePreference?: IssueSourcePreference
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
  /** Paths (relative to the primary checkout) that should be APFS clone-copied
   *  on macOS when possible, otherwise symlinked, into newly created worktrees.
   *  Undefined/empty means no shared paths are created for this repo. */
  symlinkPaths?: string[]
  /** Durable sidebar-only repo organization. Execution remains repo-scoped. */
  projectGroupId?: string | null
  /** User-authored ordering inside the project group or ungrouped bucket. */
  projectGroupOrder?: number
  /** Repo-specific source-control AI overrides. Missing fields inherit global settings. */
  sourceControlAi?: RepoSourceControlAiOverrides
  /** Transitional source for ProjectHostSetup.setupMethod while Repo remains compatibility storage. */
  projectHostSetupMethod?: RepoProjectHostSetupMethod
}

/**
 * Envelope returned by the `repos:getBaseRefDefault` IPC handler.
 *
 * Why: declared in `shared/` rather than colocated with the handler so the
 * preload bridge and renderer can import the same named type. Before this
 * lived in `src/main/git/repo.ts` — the preload layer cannot import from
 * `src/main/`, which forced three sites to inline the same structural shape
 * and risk silent drift.
 *
 * Why `remoteCount`: BaseRefPicker renders a multi-remote hint when the repo
 * has more than one configured remote; piggybacking the count on this IPC
 * avoids a second round-trip.
 *
 * Why `defaultBaseRef` (not `default`): `default` is a reserved word and is
 * awkward to destructure.
 */
export type BaseRefDefaultResult = {
  defaultBaseRef: string | null
  remoteCount: number
}

export type BaseRefSearchResult = {
  refName: string
  localBranchName: string
}
