import { PTY_SESSION_ID_SEPARATOR } from './pty-session-id-format'

export type LocalPtyBackendId = 'default' | 'rex'

/** Backend identity is not execution-host identity: local Rex still runs on this Mac. */
export function getLocalPtyBackendId(ptyId: string | undefined): LocalPtyBackendId {
  if (!ptyId) {
    return 'default'
  }
  const separator = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  const suffix = separator === -1 ? ptyId : ptyId.slice(separator + PTY_SESSION_ID_SEPARATOR.length)
  // Reserve the namespace even for a malformed Rex id; never cold-start on another backend.
  return suffix.startsWith('rex-') ? 'rex' : 'default'
}
