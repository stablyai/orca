/** What the desktop UI reads about WSL hosts (WSL-via-orcad C7); desktop-only IPC, never on the wire. */

export const WSL_HOST_STATUS_CHANNEL = 'wslHosts:statusChanged'

export type WslHostDistro = {
  name: string
  state: 'running' | 'stopped'
  /** WSL 1 runs no Linux kernel, so it cannot host orcad; null when the registry did not say. */
  version: 1 | 2 | null
  /** The WSL host already added for this distro. */
  environmentId: string | null
}

export type WslHostConnectionState =
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'distro-stopped'
  | 'unverifiable'
  | 'idle'
  | 'failed'
  | 'closed'

export type WslHostStatus = {
  environmentId: string
  distro: string
  state: WslHostConnectionState
  /** Why it failed or is unverifiable, in the main process's words. */
  detail: string | null
  /** An app update the running server waits to take (e.g. live terminals); Update/Force retry it. */
  deferredUpdate?: WslHostDeferredUpdate | null
}

export type WslHostDeferredUpdate = {
  candidateVersion: string
  /** The update planner's deferral code, as Managed servers reports it. */
  code: string
  reason: string
  /** False when forcing cannot make the update safe (e.g. it would strand terminals). */
  forceable: boolean
}

/** What this build can do for WSL hosts; the UI reads it once at startup. */
export type WslHostCapability = {
  /** False when the packaged orcad template is missing, so no WSL host can deploy or connect. */
  serverFiles: boolean
}

/** What removing a host left behind in its distro. */
export type WslHostServerStop = { stopped: true } | { stopped: false; reason: string }

export type WslHostAddFailureKind =
  | 'unsupported-wsl1'
  | 'distro-stopped'
  | 'already-added'
  | 'ssh-managed'
  | 'deferred'
  | 'disabled'
  | 'server-files-missing'
  | 'failed'

export type WslHostAddResult =
  | { ok: true; environmentId: string }
  | { ok: false; kind: WslHostAddFailureKind; message: string }

/** The host's name in Orca: the distro, marked as WSL so it reads apart from an SSH host. */
export function wslHostEnvironmentLabel(distro: string): string {
  return `${distro} (WSL)`
}
