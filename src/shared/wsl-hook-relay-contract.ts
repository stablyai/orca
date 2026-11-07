// Share Windows/guest relay paths, methods and exit codes (docs/agent-status-over-wsl.md, STA-1515).

/** Guest-side install dir for the relay bundle, relative to `$HOME`. */
export const WSL_HOOK_RELAY_DIR = '.orca-wsl/hook-relay'
export const WSL_HOOK_RELAY_BUNDLE_NAME = 'wsl-agent-hook-relay.js'
export const WSL_HOOK_RELAY_VERSION_FILE = '.version'

/** Pass the expected bundle version through WSLENV. Namespace guest installs by version so concurrent dev/prod apps cannot overwrite each other. */
export const WSL_HOOK_RELAY_VERSION_ENV = 'ORCA_WSL_HOOK_RELAY_VERSION'

/** Pass an instance key derived from the Windows endpoint path, not its changing port. Restart-surviving agents must keep sourcing the same endpoint file. */
export const WSL_HOOK_RELAY_INSTANCE_ENV = 'ORCA_WSL_HOOK_INSTANCE'

/** 42 requests one reinstall/relaunch, matching SSH handshake mismatch. */
export const WSL_HOOK_RELAY_STALE_EXIT_CODE = 42
export const WSL_HOOK_RELAY_NO_NODE_EXIT_CODE = 43

/** Reuse SSH hook installers through an SFTP-shaped adapter on the existing stdio channel; avoid per-file wsl.exe spawns. */
export const WSL_HOOK_FS_METHODS = {
  home: 'wslfs.home',
  readFile: 'wslfs.readFile',
  writeFile: 'wslfs.writeFile',
  stat: 'wslfs.stat',
  rename: 'wslfs.rename',
  unlink: 'wslfs.unlink',
  chmod: 'wslfs.chmod',
  readdir: 'wslfs.readdir',
  mkdir: 'wslfs.mkdir'
} as const

/** Carry POSIX errno as data so the host adapter can map it to SSH2 statuses understood by shared installers. */
export type WslFsFailure = {
  ok: false
  errno: string
  message: string
  fileCapacity?: { observedBytes: number; maxBytes: number }
}
export type WslFsResult<T extends object = object> = ({ ok: true } & T) | WslFsFailure

/** Restart-stable per-instance endpoint directory. Rewrite the same file so surviving agents discover fresh port/token values. */
export function wslHookRelayEndpointDir(guestHome: string, instanceKey: string): string {
  const home = guestHome.endsWith('/') ? guestHome.slice(0, -1) : guestHome
  return `${home}/.orca-wsl/agent-hooks/instance-${instanceKey}`
}

/** Keep instance keys shell/path-inert on both sides of the boundary. */
export function sanitizeWslHookInstanceKey(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed) ? trimmed : null
}

/** The guest always uses POSIX endpoint.env; the Windows host’s getEndpointFileName would choose endpoint.cmd. */
export const WSL_HOOK_RELAY_ENDPOINT_FILE = 'endpoint.env'

/** WSL transport provenance only. These panes execute locally, so ownership checks treat the prefix as null, not a remote connection. */
export const WSL_HOOK_RELAY_CONNECTION_PREFIX = 'wsl:'

export function wslHookRelayConnectionId(distro: string): string {
  return `${WSL_HOOK_RELAY_CONNECTION_PREFIX}${distro}`
}

export function isWslHookRelayConnectionId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(WSL_HOOK_RELAY_CONNECTION_PREFIX)
}

/** A hook row from this machine: unstamped, or WSL's relay, which only stamps transport provenance. */
export function isLocalHookConnectionId(value: string | null | undefined): boolean {
  return value === null || isWslHookRelayConnectionId(value)
}

export function wslHookRelayEndpointFilePath(guestHome: string, instanceKey: string): string {
  return `${wslHookRelayEndpointDir(guestHome, instanceKey)}/${WSL_HOOK_RELAY_ENDPOINT_FILE}`
}
