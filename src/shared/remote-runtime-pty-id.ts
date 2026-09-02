// Why: shared so main can name the paired runtime a mirrored PTY belongs to;
// the encoding lives here rather than in the renderer transport that mints it.
const REMOTE_PTY_ID_PREFIX = 'remote:'
const REMOTE_PTY_OWNER_SEPARATOR = '@@'

export type RemoteRuntimePtyIdParts = {
  environmentId: string | null
  handle: string
}

export function toRemoteRuntimePtyId(handle: string, environmentId?: string | null): string {
  const owner = environmentId?.trim()
  if (!owner) {
    return `${REMOTE_PTY_ID_PREFIX}${handle}`
  }
  return `${REMOTE_PTY_ID_PREFIX}${encodeURIComponent(owner)}${REMOTE_PTY_OWNER_SEPARATOR}${encodeURIComponent(handle)}`
}

export function parseRemoteRuntimePtyId(ptyId: string): RemoteRuntimePtyIdParts | null {
  if (!ptyId.startsWith(REMOTE_PTY_ID_PREFIX)) {
    return null
  }
  const rest = ptyId.slice(REMOTE_PTY_ID_PREFIX.length)
  const separatorIndex = rest.indexOf(REMOTE_PTY_OWNER_SEPARATOR)
  if (separatorIndex === -1) {
    return { environmentId: null, handle: rest }
  }
  try {
    return {
      environmentId: decodeURIComponent(rest.slice(0, separatorIndex)),
      handle: decodeURIComponent(rest.slice(separatorIndex + REMOTE_PTY_OWNER_SEPARATOR.length))
    }
  } catch {
    return null
  }
}
