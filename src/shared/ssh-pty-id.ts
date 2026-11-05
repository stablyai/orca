import { parseExecutionHostId } from './execution-host'

const SSH_PTY_ID_PREFIX = 'ssh:'
const SSH_PTY_ID_SEPARATOR = '@@'

// Restore callers may supply ssh:<targetId> host IDs; normalize before comparisons to avoid false ownership errors.
function normalizeConnectionId(connectionId: string): string {
  const parsed = parseExecutionHostId(connectionId)
  return parsed?.kind === 'ssh' ? parsed.targetId : connectionId
}

// Embed target identity because relay-local PTY IDs collide across hosts.
export type ParsedSshPtyId = {
  connectionId: string
  relayPtyId: string
}

export function parseAppSshPtyId(ptyId: string): ParsedSshPtyId | null {
  if (!ptyId.startsWith(SSH_PTY_ID_PREFIX)) {
    return null
  }
  const separatorIndex = ptyId.indexOf(SSH_PTY_ID_SEPARATOR, SSH_PTY_ID_PREFIX.length)
  if (separatorIndex === -1) {
    return null
  }
  const encodedConnectionId = ptyId.slice(SSH_PTY_ID_PREFIX.length, separatorIndex)
  const relayPtyId = ptyId.slice(separatorIndex + SSH_PTY_ID_SEPARATOR.length)
  if (!encodedConnectionId || !relayPtyId) {
    return null
  }
  try {
    return {
      connectionId: decodeURIComponent(encodedConnectionId),
      relayPtyId
    }
  } catch {
    return null
  }
}

export function toAppSshPtyId(connectionId: string, relayPtyId: string): string {
  const normalizedConnectionId = normalizeConnectionId(connectionId)
  const parsed = parseAppSshPtyId(relayPtyId)
  if (parsed) {
    if (parsed.connectionId !== normalizedConnectionId) {
      throw new Error(`PTY ${relayPtyId} belongs to SSH connection "${parsed.connectionId}"`)
    }
    return relayPtyId
  }
  return `${SSH_PTY_ID_PREFIX}${encodeURIComponent(normalizedConnectionId)}${SSH_PTY_ID_SEPARATOR}${relayPtyId}`
}

export function toRelaySshPtyId(connectionId: string, ptyId: string): string {
  const parsed = parseAppSshPtyId(ptyId)
  if (!parsed) {
    return ptyId
  }
  if (parsed.connectionId !== normalizeConnectionId(connectionId)) {
    throw new Error(`PTY ${ptyId} belongs to SSH connection "${parsed.connectionId}"`)
  }
  return parsed.relayPtyId
}

/** Compare stored relay IDs without throwing for another target; a cross-target ID simply does not match. */
export function toComparableRelaySshPtyId(connectionId: string, ptyId: string): string {
  try {
    return toRelaySshPtyId(connectionId, ptyId)
  } catch {
    return ptyId
  }
}
