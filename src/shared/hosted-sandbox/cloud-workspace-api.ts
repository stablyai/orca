// Window ↔ main contract for Orca Cloud workspace lifecycle surfaces: status panel, Restart,
// archive/unarchive, wake progress, OOM notices. Keyed by the renderer's workspace (worktree) id;
// main maps it to the Orca Cloud runtime record and its sandbox.
import type {
  HostedArchivePullRequest,
  HostedArchiveResponse,
  HostedWorkspaceStatus
} from './hosted-sandbox-wire'

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
  | { ok: false; code: CloudWorkspaceErrorCode; message: string; reason?: string | null }

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
  /** The runtime environment the wake re-pairs; panes on it hold typing for the woken terminal. */
  runtimeEnvironmentId?: string
}

export type CloudOomEvent = {
  workspaceId: string
  /** Kernel OOM-kill counter after this notice (monotonic per VM boot). */
  oomKills: number
  victim: string | null
  at: number
}

export type CloudArchiveInfo = NonNullable<HostedArchiveResponse['archive']>

export type OrcaCloudWorkspaceApi = {
  /** Live status: state, CPU/mem/disk, uptime, cost so far, archive. Cheap; the panel polls it while open. */
  getStatus: (args: { workspaceId: string }) => Promise<CloudWorkspaceResult<HostedWorkspaceStatus>>
  /** "Restart" (Unresponsive / OOM): rehydrate the same disk and re-pair; agents auto-resume. */
  restart: (args: { workspaceId: string }) => Promise<CloudWorkspaceResult<null>>
  /** Sleep, then archive with a snapshot TTL; metadata captured in the VM or from the client cache. */
  archive: (args: {
    workspaceId: string
    pullRequests?: HostedArchivePullRequest[]
  }) => Promise<CloudWorkspaceResult<null>>
  unarchive: (args: { workspaceId: string }) => Promise<CloudWorkspaceResult<null>>
  getArchive: (args: {
    workspaceId: string
  }) => Promise<CloudWorkspaceResult<CloudArchiveInfo | null>>
  /** Workspace ids of every Orca Cloud workspace this desktop knows (the sidebar dot / hover card). */
  listCloudWorkspaceIds: () => Promise<string[]>
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
  wakeProgress: 'orcaCloudWorkspace:wakeProgress',
  oom: 'orcaCloudWorkspace:oom'
} as const

/** Thrown by the desktop wake path for an archived Orca Cloud workspace: only Unarchive wakes it. */
export const CLOUD_WORKSPACE_ARCHIVED_ERROR = 'orca_cloud_workspace_archived'
