// `window.api.orcaCloudEnvironments`: org environments (shared install script + snapshot builds) in
// Orca Cloud. Main holds the token and talks to the control plane; the renderer sees only views.
import type {
  HostedEnvironmentBuildView,
  HostedEnvironmentCreateInput,
  HostedEnvironmentListEntry,
  HostedEnvironmentStaleness,
  HostedEnvironmentUpdateInput,
  HostedEnvironmentView
} from './hosted-environment-wire'

export type {
  HostedEnvironmentBuildView,
  HostedEnvironmentCreateInput,
  HostedEnvironmentListEntry,
  HostedEnvironmentStaleness,
  HostedEnvironmentUpdateInput,
  HostedEnvironmentView
}

export type OrcaCloudEnvironmentError = {
  /** Control-plane error (`forbidden`, `conflict`, `not_found`, ...) or a desktop one
   *  (`not_configured`, `unauthorized`, `timeout`, `unavailable`, `invalid_response`, `invalid_request`). */
  code: string
  /** Control-plane detail such as `admin_required`, `stale_revision`, `build_in_progress`. */
  reason?: string
  /** Friendly, user-facing sentence. */
  message: string
}

export type OrcaCloudEnvironmentResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: OrcaCloudEnvironmentError }

export type OrcaCloudEnvironmentListData = {
  environments: HostedEnvironmentListEntry[]
  canAdmin: boolean
}

export type OrcaCloudEnvironmentDetailData = {
  environment: HostedEnvironmentView
  /** Newest first, at most 30. */
  builds: HostedEnvironmentBuildView[]
  canAdmin: boolean
}

export type OrcaCloudEnvironmentBuildStreamEvent =
  | { type: 'build'; build: HostedEnvironmentBuildView }
  | { type: 'log'; stream: 'stdout' | 'stderr'; data: string; at?: number }
  /** The stream reconnected and replays the log from its first byte: clear the log buffer. */
  | { type: 'reset' }
  /** The stream dropped; main is backing off before it reconnects (a `reset` follows on success). */
  | { type: 'reconnecting' }
  /** The build reached a final status and its log is complete; no more events for this watch. */
  | { type: 'end' }
  /** The watch gave up (not found, signed out, repeated failures); no more events for this watch. */
  | { type: 'error'; message: string }

export type OrcaCloudEnvironmentBuildEvent = {
  watchId: string
  envId: string
  buildId: string
  event: OrcaCloudEnvironmentBuildStreamEvent
}

export type OrcaCloudRepoSetupImports = {
  /** Variable names (never values) the repo's Conductor / dev container config expects. */
  envVarNames: string[]
  /** The first setup command Orca's importers found, as a starting install script. */
  installScript?: string
  /** Human labels of where the suggestions came from, e.g. "Conductor (.conductor/settings.toml)". */
  sources: string[]
}

export type OrcaCloudEnvironmentsApi = {
  /** This build has an Orca Cloud control plane. Calls can still fail with `unauthorized` when signed out. */
  isConfigured: () => Promise<boolean>
  list: () => Promise<OrcaCloudEnvironmentResult<OrcaCloudEnvironmentListData>>
  get: (envId: string) => Promise<OrcaCloudEnvironmentResult<OrcaCloudEnvironmentDetailData>>
  create: (
    input: HostedEnvironmentCreateInput
  ) => Promise<OrcaCloudEnvironmentResult<{ environment: HostedEnvironmentView }>>
  update: (
    envId: string,
    patch: HostedEnvironmentUpdateInput
  ) => Promise<OrcaCloudEnvironmentResult<{ environment: HostedEnvironmentView }>>
  remove: (envId: string) => Promise<OrcaCloudEnvironmentResult<{ deleted: true }>>
  startBuild: (
    envId: string
  ) => Promise<OrcaCloudEnvironmentResult<{ build: HostedEnvironmentBuildView }>>
  cancelBuild: (
    envId: string,
    buildId: string
  ) => Promise<OrcaCloudEnvironmentResult<{ build: HostedEnvironmentBuildView }>>
  activateBuild: (
    envId: string,
    buildId: string
  ) => Promise<OrcaCloudEnvironmentResult<{ environment: HostedEnvironmentView }>>
  staleness: (
    envId: string,
    refresh?: boolean
  ) => Promise<OrcaCloudEnvironmentResult<{ staleness: HostedEnvironmentStaleness }>>
  /** Streams a build's status and log through onBuildEvent; replays the whole log first. */
  watchBuild: (
    envId: string,
    buildId: string
  ) => Promise<OrcaCloudEnvironmentResult<{ watchId: string }>>
  unwatchBuild: (watchId: string) => Promise<void>
  onBuildEvent: (callback: (event: OrcaCloudEnvironmentBuildEvent) => void) => () => void
  readRepoSetupImports: (
    repoPath: string
  ) => Promise<OrcaCloudEnvironmentResult<OrcaCloudRepoSetupImports>>
}

export const ORCA_CLOUD_ENVIRONMENT_BUILD_EVENT_CHANNEL = 'orcaCloudEnvironments:buildEvent'
