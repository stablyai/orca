/**
 * Name of the per-user directory under the home folder where Orca keeps its
 * state on this computer (settings files, credentials, agent hook scripts).
 * A downstream build that must not share state with Orca renames it here.
 */
export const ORCA_HOME_DIR_NAME = '.orca'

/**
 * The same directory on SSH hosts and WSL distros. Deliberately separate from
 * ORCA_HOME_DIR_NAME: a renamed local home must leave remote hosts on `~/.orca`,
 * where other clients and already-installed relays look, unless the client
 * tells the relay otherwise (ORCA_RELAY_HOME_DIR_ENV).
 */
export const ORCA_REMOTE_HOME_DIR_NAME = '.orca'

/** Optional relay launch variable naming the directory for relay-owned state
 *  (workspace sessions, skill installs). Unset, the relay uses
 *  ORCA_REMOTE_HOME_DIR_NAME, so today's launch and wire are unchanged. */
export const ORCA_RELAY_HOME_DIR_ENV = 'ORCA_RELAY_HOME_DIR_NAME'

const HOME_DIR_NAME_RE = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A single hidden directory name such as `.orca`; never a path. */
export function isOrcaHomeDirName(value: string): boolean {
  return HOME_DIR_NAME_RE.test(value) && !value.includes('..')
}

/** `~/.orca` (plus an optional `/`-joined child) for user-facing copy. */
export function orcaHomeDisplayPath(...segments: string[]): string {
  return ['~', ORCA_HOME_DIR_NAME, ...segments].join('/')
}

/** POSIX path of Orca's home under a remote or guest home directory. Drops
 *  one trailing slash, as every caller did before, so emitted bytes match. */
export function remoteOrcaHomePath(remoteHome: string, ...segments: string[]): string {
  return [remoteHome.replace(/\/$/, ''), ORCA_REMOTE_HOME_DIR_NAME, ...segments].join('/')
}
