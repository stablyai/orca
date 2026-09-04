/**
 * How many bytes of a unix socket path the kernel will accept.
 *
 * `sockaddr_un.sun_path` is a fixed-size byte array rather than a pointer, so this is a hard
 * kernel limit with nothing to do with PATH_MAX. Bytes and not characters: a data root with
 * a non-ASCII component spends more of the budget than its length suggests.
 *
 * Refusing up front rather than letting `bind` report the problem, because past the limit
 * there is no single failure to report. Measured on Linux (node 22 / libuv 1.51), binding a
 * path of:
 *   - 109-110 bytes fails EADDRINUSE against an empty directory, naming a free path;
 *   - 111+ bytes SUCCEEDS, and connect() to it succeeds, but no directory entry is ever
 *     created — so it reads as a healthy daemon to everything except code that stats the
 *     entry, which is what daemon endpoint ownership is built out of.
 * Only the arithmetic is the same on every host, so only the arithmetic is worth trusting.
 */
export const UNIX_SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108

/** TextEncoder rather than Buffer: this module is shared, and Buffer is not universal. */
export function unixSocketPathBytes(socketPath: string): number {
  return new TextEncoder().encode(socketPath).length
}

export type UnixSocketPathBudget = {
  /** The longest of the candidates — the one that decides whether any of them work. */
  longestPath: string
  bytes: number
  limit: number
  fits: boolean
}

/**
 * Measures the candidates a component must bind or connect to, and reports the longest.
 * Longest rather than one nominated path: which name is longest is a property of how they
 * are built, and a caller that hardcodes the answer stops being right when a name changes.
 */
export function measureUnixSocketPathBudget(candidates: string[]): UnixSocketPathBudget {
  const longestPath = candidates.reduce((a, b) =>
    unixSocketPathBytes(b) > unixSocketPathBytes(a) ? b : a
  )
  const bytes = unixSocketPathBytes(longestPath)
  return {
    longestPath,
    bytes,
    limit: UNIX_SOCKET_PATH_LIMIT,
    fits: bytes <= UNIX_SOCKET_PATH_LIMIT
  }
}
