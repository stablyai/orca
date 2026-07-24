// Shared contract between the Windows host and the guest-resident WSL
// agent-hook relay. Both sides derive paths/methods from here so the guest
// process and the host manager can never drift on where the relay lives,
// which JSON-RPC methods the fs bridge speaks, or which exit codes signal
// "reinstall me" vs "no usable node".
// See docs/agent-status-over-wsl.md (STA-1515).

/** Guest-side install dir for the relay bundle, relative to `$HOME`. */
export const WSL_HOOK_RELAY_DIR = '.orca-wsl/hook-relay'
export const WSL_HOOK_RELAY_BUNDLE_NAME = 'wsl-agent-hook-relay.js'
export const WSL_HOOK_RELAY_VERSION_FILE = '.version'

/** Host-expected bundle version, crossed into the guest launch script via
 *  WSLENV so a stale guest install is detected by the guest itself. Also
 *  namespaces the guest install dir, so concurrent Orca instances with
 *  different bundle versions (dev + prod) never reinstall over each other. */
export const WSL_HOOK_RELAY_VERSION_ENV = 'ORCA_WSL_HOOK_RELAY_VERSION'

/** Stable per-instance identity for the guest endpoint dir, crossed via
 *  WSLENV. Derived from the Windows endpoint file path (userData +
 *  namespace), NOT the hook port: the port changes every app launch, and a
 *  port-keyed dir would leave daemon-surviving agents sourcing a stale file
 *  after an Orca restart — the exact re-coordination this exists to serve. */
export const WSL_HOOK_RELAY_INSTANCE_ENV = 'ORCA_WSL_HOOK_INSTANCE'

/** Launch-script exit codes. 42 mirrors the SSH relay's handshake-mismatch
 *  convention: the host reinstalls the bundle and relaunches once. */
export const WSL_HOOK_RELAY_STALE_EXIT_CODE = 42
export const WSL_HOOK_RELAY_NO_NODE_EXIT_CODE = 43

/** JSON-RPC methods for the relay's home-scoped fs bridge. The host runs the
 *  unchanged SSH remote hook installers against these via an SFTP-shaped
 *  adapter, so hook installation rides the already-open stdio channel instead
 *  of per-file wsl.exe spawns. */
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

/** Result envelope for every fs-bridge method. Errors travel as data (not
 *  JSON-RPC faults) so the host adapter can map POSIX errno onto the ssh2
 *  status codes the shared installer error-classifiers already understand. */
export type WslFsFailure = { ok: false; errno: string; message: string }
export type WslFsResult<T extends object = object> = ({ ok: true } & T) | WslFsFailure

/** Where the guest relay publishes its endpoint file. Keyed by the stable
 *  instance key (restart-stable, instance-unique), so a restarted instance's
 *  relay REWRITES the same file that surviving agents' env already names —
 *  that rewrite is what re-coordinates them onto fresh port/token. */
export function wslHookRelayEndpointDir(guestHome: string, instanceKey: string): string {
  const home = guestHome.endsWith('/') ? guestHome.slice(0, -1) : guestHome
  return `${home}/.orca-wsl/agent-hooks/instance-${instanceKey}`
}

/** Keep instance keys shell/path-inert on both sides of the boundary. */
export function sanitizeWslHookInstanceKey(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? ''
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed) ? trimmed : null
}

/** The guest is always POSIX, so the Windows host must name the guest's
 *  endpoint file explicitly — its own `getEndpointFileName()` would say
 *  `endpoint.cmd`. Matches the POSIX branch of that helper. */
export const WSL_HOOK_RELAY_ENDPOINT_FILE = 'endpoint.env'

/** connectionId stamped on WSL-relayed hook envelopes. Transport provenance
 *  only: the pane is a LOCAL pane on a local repo, so ownership checks must
 *  treat these ids as local (null), not as a remote connection. */
export const WSL_HOOK_RELAY_CONNECTION_PREFIX = 'wsl:'

export function wslHookRelayConnectionId(distro: string): string {
  return `${WSL_HOOK_RELAY_CONNECTION_PREFIX}${distro}`
}

export function isWslHookRelayConnectionId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(WSL_HOOK_RELAY_CONNECTION_PREFIX)
}

export function wslHookRelayEndpointFilePath(guestHome: string, instanceKey: string): string {
  return `${wslHookRelayEndpointDir(guestHome, instanceKey)}/${WSL_HOOK_RELAY_ENDPOINT_FILE}`
}
