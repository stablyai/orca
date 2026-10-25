import type { SshPendingPtyKill } from './ssh-pending-pty-kill'
import type { OrcadSshProvisioningIntent } from './orcad-ssh-provisioning'
import type { NodeDistMirrorAttempt } from './node-dist-mirror'

export const MIN_SSH_RELAY_GRACE_PERIOD_SECONDS = 60
export const MAX_SSH_RELAY_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60
export const LEGACY_DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS = 3 * 60 * 60

/** pinned-node uses uploaded Node/prebuilt addons (D6 ladder/D5 design); opt-in legacy uses host Node/npm native deps. */
export const SSH_REMOTE_RUNTIMES = ['legacy', 'pinned-node'] as const
export type SshRemoteRuntime = (typeof SSH_REMOTE_RUNTIMES)[number]

/** Where the design D6 fallback ladder landed; `legacy` is the opt-in host-npm path outside it. */
export const SSH_REMOTE_RUNTIME_RUNGS = ['A', 'B', 'C', 'D', 'legacy'] as const
export type SshRemoteRuntimeRung = (typeof SSH_REMOTE_RUNTIME_RUNGS)[number]

/** Main-owned ladder cache; changes to glibc, pinned-runtime hash or Orca major invalidate it. */
export type SshRemoteRuntimeResolution = {
  rung: SshRemoteRuntimeRung
  /** The classified refusal that stepped off Orca's pinned Node, when one did. */
  pinnedRefusal?: string
  /** Epoch ms the refusal was proved; a refusal the host can lose expires from it. */
  refusedAt?: number
  glibc: string | null
  runtimeSha256: string
  orcaMajor: number
}

/** Who created a hidden target as an implementation detail, and so owns its lifecycle. */
export type SshTargetOwner = { type: 'on-demand-runtime'; runtimeId: string }

export type SshTarget = {
  id: string
  label: string
  /** Internal targets are hidden from normal host management. */
  owner?: SshTargetOwner
  /** Host alias to resolve through OpenSSH config (ssh -G). */
  configHost?: string
  host: string
  port: number
  username: string
  /** Path to private key file, if using key-based auth. */
  identityFile?: string
  /** SSH agent socket path from IdentityAgent, if configured. */
  identityAgent?: string
  /** Whether OpenSSH IdentitiesOnly should limit public-key auth attempts. */
  identitiesOnly?: boolean
  /** ssh2 lacks gssapi-with-mic; configured Kerberos targets try system OpenSSH first. */
  gssapiAuthentication?: boolean
  /** ProxyCommand from SSH config, if any. */
  proxyCommand?: string
  /** Jump host (ProxyJump), if any. */
  jumpHost?: string
  /** ssh-config refreshes config-derived fields on import; manual is never overwritten.
   * Legacy absent source is adopted only when the old import shape matches (ssh-target-source.ts). */
  source?: 'ssh-config' | 'manual'
  /** Grace period in seconds before relay shuts down after disconnect.
   *  0 disables expiry. Default: 0 (until reset). Max: 604800 (7 days). */
  relayGracePeriodSeconds?: number
  /** Allow this host’s CLI to drive desktop browser tabs in its workspaces and relay-era terminal orchestration.
   * Enabled unless false; use isRemoteCliControlAllowed. */
  allowRemoteCliControl?: boolean
  /** Retired: written by earlier builds and ignored now. Kept so a downgrade still finds its stamp. */
  allowRemoteCliControlConsent?: 'desktop-browser-bridge'
  /** Persist prompted-auth history so startup defers credential-requiring hosts without attempting a connection. */
  lastRequiredPassphrase?: boolean
  portForwards?: SavedPortForward[]
  /** Reuse a system OpenSSH connection across setup commands. Undefined means
   *  enabled; false is an explicit per-target compatibility opt-out. */
  systemSshConnectionReuse?: boolean
  /** Windows only: hold one loopback tunnel through a ProxyCommand/ProxyJump and run later
   *  commands over it. Opt-in; undefined means off. */
  systemSshProxyConnectionReuse?: boolean
  /** Relay runtime for this host; undefined means pinned-node. */
  remoteRuntime?: SshRemoteRuntime
  /** Main-owned ladder cache; renderer updates never set it. */
  remoteRuntimeResolution?: SshRemoteRuntimeResolution
  /** Main-owned registration incarnation fences automation reuse after create/re-create/re-adopt; connect state never advances it. */
  generation?: number
  /** Main-owned provisioning intent; never fall back to a relay while it exists. */
  orcadProvisioning?: OrcadSshProvisioningIntent
  /** Main-owned: managed orcad can't run on this host; retried once this app version changes. */
  managedServerUnavailable?: { reason: string; appVersion: string }
  /** Retired with the move offer (hosts convert on connect); kept so a downgraded build doesn't re-offer. */
  managedServerMoveOffered?: { appVersion: string }
  /** Confirmed “Move anyway” leaves uncarried state in the desktop profile; clear after the move. */
  managedServerLeaveBehind?: { confirmedAt: string }
  /** Main-owned: updating the managed server to this app version failed; retried once it changes. */
  managedServerUpdateFailure?: { reason: string; appVersion: string }
  orcadFence?: {
    environmentId: string
    /** The retained source holds projects no move took: the host is unserved until moved again. */
    sourceChangedAt?: string
  }
}

/** Renderer-authored target fields; registration generations are allocated and owned by main. */
export type SshTargetCreateInput = Omit<
  SshTarget,
  | 'id'
  | 'generation'
  | 'orcadProvisioning'
  | 'orcadFence'
  | 'managedServerUnavailable'
  | 'managedServerMoveOffered'
  | 'managedServerLeaveBehind'
  | 'managedServerUpdateFailure'
>
export type SshTargetUpdateInput = Partial<SshTargetCreateInput>

/** Public target identity and observed host metadata safe to mirror to a paired client. */
export type SshTargetSummary = Pick<SshTarget, 'id' | 'label' | 'generation'> & {
  /** The SSH host's OS, when it has connected and the relay has detected it. */
  remotePlatform?: SshRemotePlatform
  /** Whether the target currently has a host-owned connected SSH lifecycle. */
  connected?: boolean
  /** Current SSH lifecycle state, when the desktop has one for this target. */
  connectionStatus?: SshConnectionStatus
}

/** Re-adopt orphaned repos/worktrees onto a replacement target ID; those records retain only the deleted target ID. */
export type RemovedSshTargetTombstone = {
  oldTargetId: string
  /** ssh-config alias, if any — the most stable re-adoption key. */
  configHost?: string
  host: string
  port: number
  username: string
  label: string
  /** ms epoch when the target was removed, for pruning old tombstones. */
  removedAt: number
}

/** Exact repo ownership changes made while re-adopting a removed SSH host. */
export type SshRepoReadoption = {
  oldTargetId: string
  newTargetId: string
  repoIds: string[]
}

export type SshTargetAddResult = {
  target: SshTarget
  repoReadoptions: SshRepoReadoption[]
}

export type SshConfigImportResult = {
  targets: SshTarget[]
  repoReadoptions: SshRepoReadoption[]
}

/** Concrete Host entry from ~/.ssh/config, for pickers that prefill the add-host form. */
export type SshConfigHostSummary = {
  alias: string
  hostname: string
  port: number
  username: string
  identityFile?: string
  proxyCommand?: string
  jumpHost?: string
  /** True when an Orca SSH target already uses this config alias. */
  alreadyInOrca: boolean
  /** Deleted alias remains explicitly selectable; passive/Add all import excludes it until re-adoption or save. */
  previouslyRemoved?: boolean
}

export const SSH_CONFIG_HOST_RESULT_LIMIT = 100

export type SshConfigHostListResult = {
  hosts: SshConfigHostSummary[]
  totalHostCount: number
  newHostCount: number
  matchCount: number
  hasMore: boolean
}

/** `refresh` re-reads ~/.ssh/config; filter keystrokes reuse the cached parse. */
export type SshConfigHostListArgs = { query?: string; refresh?: boolean }

/** Effective OpenSSH values used to prefill one manually managed target. */
export type SshConfigHostResolution = {
  alias: string
  hostname: string
  port: number
  username: string
  identityFiles: string[]
  identityAgent?: string
  identitiesOnly: boolean
  forwardAgent: boolean
  gssapiAuthentication?: boolean
  proxyCommand?: string
  proxyUseFdpass: boolean
  jumpHost?: string
}

export type SavedPortForward = {
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

/** A saved forward that isn't open on this connection; `error` is why its last start failed. */
export type UnrestoredPortForward = SavedPortForward & {
  error?: string
  /** It ran, then its process died, rather than never starting. */
  stopped?: true
}

export type SshConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'auth-failed'
  | 'deploying-relay'
  | 'connected'
  | 'reconnecting'
  | 'reconnection-failed'
  | 'error'

export type SshRemotePlatform = 'linux' | 'darwin' | 'win32'

export type SshProviderEpoch = string & { readonly __sshProviderEpoch: unique symbol }

export type DirectSshAuthority = {
  targetId: string
  providerEpoch: SshProviderEpoch
  connectionGeneration: number
}

export type SshConnectionState = {
  targetId: string
  status: SshConnectionStatus
  error: string | null
  /** Number of reconnection attempts since last disconnect. */
  reconnectAttempt: number
  /** Opaque provider-incarnation token issued by main. */
  providerEpoch?: SshProviderEpoch | null
  /** Non-secret owner token used to reject mutations captured for an obsolete SSH session. */
  connectionGeneration?: number
  /** Folder downloads require ssh2 SFTP and are unavailable on system SSH. */
  supportsFolderDownload?: boolean
  /** Remote OS detected by the SSH relay once available. */
  remotePlatform?: SshRemotePlatform
  /** Set while connected without the Orca remote server (runtime ladder rung D). */
  plainSsh?: SshPlainSshMode
  /** Set while the relay runs on the opt-in host-Node runtime, an unsupported configuration. */
  hostNodeRuntime?: boolean
  /** Which server this host runs; optional so older clients simply ignore it. */
  managedServer?: SshManagedServerStatus
}

export const SSH_MANAGED_SERVER_PHASES = [
  'deploying',
  'converting',
  'connecting',
  'updating',
  'starting'
] as const

// Every state but host-newer means the server may be behind this app. Readers drop unknown states.
export const SSH_MANAGED_SERVER_UPDATE_STATES = [
  'host-newer',
  'deferred',
  'failed',
  'rolled-back',
  'no-template',
  'migrating',
  'check-failed'
] as const

/** Why a managed server kept its version on this connect; absent when it is current or updated. */
export type SshManagedServerUpdateNote = {
  state: (typeof SSH_MANAGED_SERVER_UPDATE_STATES)[number]
  detail?: string
}

/** A project the server already held at the same host path: this desktop uses the server's now. */
export type SshManagedServerLinkedProject = {
  path: string
  /** This desktop's automations on it, which stay behind with its tabs. */
  automations: number
}

/** A managed server that did not answer and was not proven serving, with why (and orcad.log's tail). */
export type SshManagedServerServingNote = { state: 'unverifiable'; detail: string }

export const SSH_MANAGED_SERVER_RELAY_REASONS = [
  'orcad_unavailable',
  'relay_terminals_live',
  'relay_terminals_unverifiable',
  'source_changed',
  'deferred',
  'refused',
  'failed'
] as const

export type SshManagedServerRelayReason = (typeof SSH_MANAGED_SERVER_RELAY_REASONS)[number]

export type SshManagedServerStatus =
  | {
      kind: 'managed'
      environmentId: string
      update?: SshManagedServerUpdateNote
      /** Set when the server did not answer and no start brought it up; never a terminal verdict. */
      serving?: SshManagedServerServingNote
      /** Set on the connect that moved this host's projects, when some were linked instead. */
      linked?: SshManagedServerLinkedProject[]
      /**
       * macOS 15+: the SSH session that started this server proved exited, so its terminals may
       * have lost Local Network access (#25934). Absent when unknown, e.g. an older launch.
       */
      launchSessionEnded?: true
    }
  | { kind: 'setting-up'; phase: (typeof SSH_MANAGED_SERVER_PHASES)[number] }
  /** `detail` names the blocker for a refusal, or why orcad can't run on the host. */
  | {
      kind: 'relay'
      reason: SshManagedServerRelayReason
      detail?: string
      /** Relay terminals still running, when that is what keeps the host on the relay. */
      terminals?: number
      /** Those terminals belong to another Orca desktop or session, so this one offers no move. */
      terminalsElsewhere?: boolean
      /** The refusal is only saved state the user may leave on this desktop ("Move anyway"). */
      canLeaveBehind?: true
      /** A move to the managed server stopped short and keeps the host locked until it resumes. */
      held?: true
      /** Setup lost contact with the host, so nothing proves it failed there. */
      contactLost?: true
      /** Neither this computer nor the host could download the pinned Node runtime. */
      nodeDownloadBlocked?: SshManagedServerNodeDownloadBlocked
      /** COMPAT(legacy-relay-bridge): the connect stayed up so the bridge serves those terminals. */
      bridged?: true
    }

/** `mirror`: whether that download went through a mirror; admission drops an unknown value. */
export type SshManagedServerNodeDownloadBlocked = { mirror: NodeDistMirrorAttempt }

/** Plain SSH terminals and SFTP browsing only; `reason` is the ladder's classified cause. */
export type SshPlainSshMode = {
  reason: string
  message: string
}

/** Non-secret mutation provenance. Both fields are required when an SSH provider is selected. */
export type SshMutationExpectation = {
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

export type SshRemotePtyLeaseState = 'attached' | 'detached' | 'terminated' | 'expired'

export type SshRemotePtyLease = {
  targetId: string
  ptyId: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  state: SshRemotePtyLeaseState
  createdAt: number
  updatedAt: number
  lastAttachedAt?: number
  lastDetachedAt?: number
  /** Client-local unconfirmed stop for replay to the same target; see ssh-pending-pty-kill.ts. Never sent on the wire. */
  pendingKill?: SshPendingPtyKill
  /** Stored-form winning lease ID, written by supersession; live upserts clear it so recycled IDs cannot inherit the mark. */
  supersededBy?: string
  /** Pending-stop replay proved a different incarnation owns this ID (relay-id-recycled); never reattach this lease. */
  relayIdRecycled?: true
}

/** Attached/detached still claim a running terminal; expired lost its route, while only terminated proves exit. */
export function isLiveSshPtyLease(lease: Pick<SshRemotePtyLease, 'state'>): boolean {
  return lease.state === 'attached' || lease.state === 'detached'
}

/** Expired means lost client route, never proven remote exit (ssh-execution-boundary.md).
 * Superseded/recycled marks prove this route unusable; unmarked orphans may reattach to discover whether the shell survived. */
export function sshRemotePtyLeaseAllowsReattach(
  lease: Pick<SshRemotePtyLease, 'state' | 'supersededBy' | 'relayIdRecycled'>
): boolean {
  if (lease.state === 'terminated') {
    return false
  }
  return (
    lease.state !== 'expired' ||
    (lease.supersededBy === undefined && lease.relayIdRecycled !== true)
  )
}

/** Main-owned relay lease needed to reclaim PTY delivery after a desktop restart. */
export type SshPtyConsumerRecovery = {
  targetId: string
  clientInstanceId: string
  serverBuildId: string
  clientGeneration: number
  ownerGeneration: number
  ownerLease: string
  outputFlowControl?: {
    version: 1
    windowSu: number
  }
}

export type PortForwardEntry = {
  id: string
  connectionId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
  /** Remote terminal-advertised origin; renderer rewrites the forwarded port and relies on the user’s custom-host DNS. */
  advertisedUrl?: string
  /** Use advertised HTTPS even when its hostname cannot be reused locally. */
  advertisedProtocol?: 'http' | 'https'
}

export type DetectedPort = {
  port: number
  host: string
  pid?: number
  processName?: string
}

/** Main maps terminal-advertised URLs onto relay scan rows for IPC/UI. */
export type EnrichedDetectedPort = DetectedPort & {
  advertisedUrl?: string
  advertisedProtocol?: 'http' | 'https'
}
