/** Desktop-only WSL host IPC; never part of the wire protocol (C7). */
import type { WslHostCopyParams } from './wsl-host-failure-copy'

export const WSL_HOST_STATUS_CHANNEL = 'wslHosts:statusChanged'
/** Main's capability changed mid-run, such as a live policy block stopping new work. */
export const WSL_HOST_CAPABILITY_CHANNEL = 'wslHosts:capabilityChanged'
/** What an in-flight Add waits for, before the host has a status of its own. */
export const WSL_HOST_ADD_PROGRESS_CHANNEL = 'wslHosts:addProgress'

/** The launch step an Add's connect is on; deploy can't tell a fresh install from a no-op one, so both read as installing. */
export type WslHostAddStage = 'starting-distro' | 'installing-server' | 'connecting'

/** `detail` is null once the Add no longer waits on anything it can name. */
export type WslHostAddProgress = {
  distro: string
  /** Absent from older mains. */
  stage?: WslHostAddStage
  detail: string | null
  detailCode?: string
  detailParams?: WslHostCopyParams
}

export type WslHostDistro = {
  name: string
  /** 'unverifiable': WSL's running list couldn't be read, so Orca can't say. */
  state: 'running' | 'stopped' | 'unverifiable'
  /** WSL 1 runs no Linux kernel, so it cannot host orcad; null when the registry did not say. */
  version: 1 | 2 | null
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
  /** `detail`'s WSL_HOST_STATUS_DETAIL_COPY code; absent when `detail` is verbatim diagnostic text. */
  detailCode?: string
  detailParams?: WslHostCopyParams
  /** An app update the running server waits to take (e.g. live terminals); Update/Force retry it. */
  deferredUpdate?: WslHostDeferredUpdate | null
  /** A Remove that could not prove the server stopped; `detail` says why. Remove retries it. */
  removalPending?: boolean
}

/**
 * An explicit Update retries a skipped build behind the terminal census; Force also passes it.
 * Restart-as-WSL-host ends the server's terminals, then starts it again as a WSL host.
 */
export type WslHostConnectIntent = WslHostUpdateIntent | 'restart-as-wsl-host'
export type WslHostUpdateIntent = 'update' | 'force'

/**
 * The distro's server was started some other way (usually by an SSH host), without the WSL host
 * marker, and terminals keep it from restarting on its own. It cannot take moved projects.
 */
export const ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE = 'orcad_not_started_as_wsl_host'

/** Update anyway over an uncounted census: Update's admission, pinned to the build the user confirmed. */
export type WslHostPastUncountedTerminals = { incumbentVersion: string | null }

/** A host a newer Orca runs refused this build: only Force (or updating Orca) changes that. */
export const ORCAD_HOST_NEWER_DEFERRAL_CODE = 'orcad_host_newer'

/** A project move to the host runs on this desktop; the update waits for it to finish. */
export const ORCAD_UPDATE_WSL_MOVE_RUNNING_CODE = 'orcad_update_wsl_move_running'

export type WslHostDeferredUpdate = {
  candidateVersion: string
  /** The update planner's deferral code, as Managed servers reports it. */
  code: string
  reason: string
  /** False when forcing cannot make the update safe (e.g. it would strand terminals). */
  forceable: boolean
  /** The build the deferral was decided over; Update anyway is pinned to it. Absent from older mains. */
  incumbentVersion?: string | null
}

export type WslHostCapability = {
  /** False when the packaged orcad template is missing, so no WSL host can deploy or connect. */
  serverFiles: boolean
  /** False in serve-only or after a live policy block: saved hosts work, but nothing is added or moved. Absent from older mains. */
  acceptsNewWork?: boolean
}

/**
 * What removing a host left behind in its distro, in the census vocabulary: `live` when something
 * is proven still running, `unverifiable` when Orca could not tell. `kept` (E11): the host stays
 * listed with its stop pending, so Remove can retry; older mains removed it anyway.
 */
export type WslHostServerStop =
  /** `keptForOtherDesktops`: another Orca shares the server, so only this desktop let go of it. */
  | { stopped: true; keptForOtherDesktops?: string[] }
  | {
      stopped: false
      reason: string
      /** `reason`'s WSL_HOST_STATUS_DETAIL_COPY code, when it is one coded sentence. */
      reasonCode?: string
      reasonParams?: WslHostCopyParams
      verdict?: 'live' | 'unverifiable'
      kept?: boolean
    }

export type WslHostAddFailureKind =
  | 'unsupported-wsl1'
  /** Its platform, libc or loader can't run Orca's server (e.g. NixOS, musl without libstdc++). */
  | 'unsupported-distro'
  | 'distro-stopped'
  | 'already-added'
  | 'ssh-managed'
  | 'deferred'
  | 'disabled'
  | 'server-files-missing'
  | 'failed'

export type WslHostAddResult =
  | { ok: true; environmentId: string }
  | {
      ok: false
      kind: WslHostAddFailureKind
      message: string
      /** `message`'s WSL_HOST_ADD_REFUSAL_COPY code; absent when `message` is verbatim error text. */
      errorCode?: string
      errorParams?: WslHostCopyParams
    }

export function wslHostEnvironmentLabel(distro: string): string {
  return `${distro} (WSL)`
}
