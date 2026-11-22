export const SSH_CONNECT_LINK_MAX_LENGTH = 128
const SSH_CONNECT_LINK_PREFIX = 'orca://ssh'
// A plain Host name: a leading `-` would read as an ssh option, and patterns (`*`, `?`, `!`) name no one host.
const SSH_CONNECT_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Names a host only; its user, keys and certificates stay in ssh config, so a link never carries them. */
export type SshConnectLink = { alias: string }

/** True for anything shaped like an SSH link, valid or not, so a malformed one still reaches the error toast. */
export function isSshConnectLinkArgument(value: string): boolean {
  const lower = value
    .trim()
    .slice(0, SSH_CONNECT_LINK_PREFIX.length + 1)
    .toLowerCase()
  return lower === `${SSH_CONNECT_LINK_PREFIX}/` || lower === `${SSH_CONNECT_LINK_PREFIX}?`
}

export function sshConnectLinkFromArguments(argv: readonly string[]): string | null {
  const value = argv.find(isSshConnectLinkArgument)
  // Why one past the cap: an oversized link must still fail parsing (and toast), not be trimmed valid.
  return value ? value.trim().slice(0, SSH_CONNECT_LINK_MAX_LENGTH + 1) : null
}

/** `orca://ssh/connect?alias=<ssh config Host alias>`; null when malformed. */
export function parseSshConnectLink(value: string): SshConnectLink | null {
  if (value.length > SSH_CONNECT_LINK_MAX_LENGTH || !isSshConnectLinkArgument(value)) {
    return null
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const aliases = url.searchParams.getAll('alias')
  if (url.hostname !== 'ssh' || !/^\/connect\/?$/.test(url.pathname) || url.hash) {
    return null
  }
  if (aliases.length !== 1 || [...url.searchParams.keys()].some((key) => key !== 'alias')) {
    return null
  }
  const alias = aliases[0]!
  return SSH_CONNECT_ALIAS_PATTERN.test(alias) ? { alias } : null
}
