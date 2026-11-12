// Window ↔ main contract for Orca Cloud workspace lifecycle surfaces: status panel, Restart,
// archive/unarchive, wake progress, OOM notices. Keyed by the renderer's workspace (worktree) id;
// main maps it to the Orca Cloud runtime record and its sandbox.
import type {
  HostedArchivePullRequest,
  HostedArchiveResponse,
  HostedSandboxConfigResponse,
  HostedWorkspaceStatus
} from './hosted-sandbox-wire'
import type {
  HostedGithubRepoAccessResponse,
  HostedGithubRepositoriesResponse,
  HostedGithubUser
} from './hosted-github-wire'

export type CloudWorkspaceErrorCode =
  | 'not_cloud'
  | 'unauthorized'
  | 'entitlement_denied'
  | 'conflict'
  | 'unavailable'
  | 'not_found'
  | 'failed'

export type CloudWorkspaceResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      code: CloudWorkspaceErrorCode
      message: string
      reason?: string | null
      /** Copy written for people (renderer-authored); shown as is. `message` may be raw. */
      userMessage?: string
    }

/** Why a wake started; every source goes through the control plane's single-flight wake. */
export type CloudWakeSource = 'open' | 'message' | 'ssh' | 'preview' | 'restart' | 'unarchive'

export type CloudWakeProgressEvent = {
  workspaceId: string
  phase: 'waking' | 'connecting' | 'ready' | 'failed'
  source: CloudWakeSource
  /** Epoch ms the wake began (the overlay's elapsed timer). */
  startedAt: number
  at: number
  message?: string
}

export type CloudOomEvent = {
  workspaceId: string
  /** Kernel OOM-kill counter after this notice (monotonic per VM boot). */
  oomKills: number
  victim: string | null
  at: number
}

/** The status panel's read plus what the desktop needs from the sandbox view alongside it. */
export type CloudWorkspaceStatus = HostedWorkspaceStatus & {
  /** GIT-SETUP: commits and pushes are refused in the VM until a boot installs the identities. */
  gitSetupFailed?: true
}

export type CloudArchiveInfo = NonNullable<HostedArchiveResponse['archive']>

/** A cloud workspace by its sidebar id; a paired one also names its server's environment. */
export type CloudWorkspaceTarget = { workspaceId: string; environmentId?: string }

export type OrcaCloudWorkspaceApi = {
  /**
   * Live status: state, CPU/mem/disk, uptime, cost so far, archive. Cheap; the panel polls it while open.
   * `environmentId` names a PAIRED workspace's server (no runtime record on this desktop): main
   * answers for it only when that server is bound to a cloud sandbox.
   */
  getStatus: (args: CloudWorkspaceTarget) => Promise<CloudWorkspaceResult<CloudWorkspaceStatus>>
  /** "Restart" (Unresponsive / OOM): rehydrate the same disk and re-pair; agents auto-resume. */
  restart: (args: { workspaceId: string }) => Promise<CloudWorkspaceResult<null>>
  /** Sleep, then archive with a snapshot TTL; metadata captured in the VM or from the client cache. */
  archive: (args: {
    workspaceId: string
    pullRequests?: HostedArchivePullRequest[]
  }) => Promise<CloudWorkspaceResult<null>>
  unarchive: (args: { workspaceId: string }) => Promise<CloudWorkspaceResult<null>>
  getArchive: (args: CloudWorkspaceTarget) => Promise<CloudWorkspaceResult<CloudArchiveInfo | null>>
  /** Workspace ids of every Orca Cloud workspace this desktop knows (the sidebar dot / hover card). */
  listCloudWorkspaceIds: () => Promise<string[]>
  /** Product constants and measured timings; null when the control plane can't be reached. */
  getConfig: () => Promise<HostedSandboxConfigResponse | null>
  /**
   * Opens GitHub in the browser to give Orca Cloud access to the account's repositories. With a
   * repository, GitHub's page preselects it, and a setup session gets the browser back afterwards.
   */
  connectGitHub: (args?: {
    repoUrl?: string
    setupSessionId?: string
  }) => Promise<CloudWorkspaceResult<null>>
  /** Whether the signed-in person connected their own GitHub (cloud commit attribution). */
  getGitHubUser: () => Promise<CloudWorkspaceResult<HostedGithubUser>>
  /** Opens GitHub's OAuth page in the browser so the person connects their own GitHub identity. */
  connectGitHubUser: () => Promise<CloudWorkspaceResult<null>>
  /** Forgets the person's GitHub identity; cloud commits use Orca Cloud's name again. */
  disconnectGitHubUser: () => Promise<CloudWorkspaceResult<HostedGithubUser>>
  /** Can Orca Cloud clone this https GitHub repository for the signed-in account (cloud-start N2)? */
  getRepoAccess: (args: {
    repoUrl: string
    setupSessionId?: string
  }) => Promise<CloudWorkspaceResult<HostedGithubRepoAccessResponse>>
  /** One page of the repositories the account's GitHub installations reach (cloud-start N12). */
  listGitHubRepositories: (args: {
    cursor?: string | null
  }) => Promise<CloudWorkspaceResult<HostedGithubRepositoriesResponse>>
  /**
   * Starts a sandbox that clones a GitHub repository with no copy on this computer (cloud-start
   * D4). Resolves once it is ready; the window then opens it like any cloud workspace.
   */
  createFromGitHub: (args: {
    repoUrl: string
    /** The name typed in the composer; becomes the workspace's title (NAME-DROPPED). */
    title?: string
  }) => Promise<CloudWorkspaceResult<{ sandboxId: string }>>
  onWakeProgress: (callback: (event: CloudWakeProgressEvent) => void) => () => void
  onOom: (callback: (event: CloudOomEvent) => void) => () => void
}

export const ORCA_CLOUD_WORKSPACE_CHANNELS = {
  getStatus: 'orcaCloudWorkspace:getStatus',
  restart: 'orcaCloudWorkspace:restart',
  archive: 'orcaCloudWorkspace:archive',
  unarchive: 'orcaCloudWorkspace:unarchive',
  getArchive: 'orcaCloudWorkspace:getArchive',
  listCloudWorkspaceIds: 'orcaCloudWorkspace:listIds',
  getConfig: 'orcaCloudWorkspace:getConfig',
  connectGitHub: 'orcaCloudWorkspace:connectGitHub',
  getGitHubUser: 'orcaCloudWorkspace:getGitHubUser',
  connectGitHubUser: 'orcaCloudWorkspace:connectGitHubUser',
  disconnectGitHubUser: 'orcaCloudWorkspace:disconnectGitHubUser',
  getRepoAccess: 'orcaCloudWorkspace:getRepoAccess',
  listGitHubRepositories: 'orcaCloudWorkspace:listGitHubRepositories',
  createFromGitHub: 'orcaCloudWorkspace:createFromGitHub',
  wakeProgress: 'orcaCloudWorkspace:wakeProgress',
  oom: 'orcaCloudWorkspace:oom'
} as const

/** Thrown by the desktop wake path for an archived Orca Cloud workspace: only Unarchive wakes it. */
export const CLOUD_WORKSPACE_ARCHIVED_ERROR = 'orca_cloud_workspace_archived'
