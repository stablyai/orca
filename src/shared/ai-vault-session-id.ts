import { createHash } from 'node:crypto'
import type { AiVaultAgent } from './ai-vault-types'
import type { ExecutionHostId } from './execution-host'

export function buildAiVaultSessionId(args: {
  executionHostId: ExecutionHostId
  agent: AiVaultAgent
  sessionId: string
  filePath: string
  previousId?: string
  cursorStorageContextKey?: string
  cursorBucketCollision?: string
  cursorLegacyPathCollision?: string
}): string {
  const prefix = `${args.executionHostId}:${args.agent}:${args.sessionId}`
  if (args.agent !== 'cursor') {
    return `${prefix}:${args.filePath}`
  }
  const preservedSuffix = cursorIdentitySuffix(args.previousId, args.sessionId)
  if (preservedSuffix !== null) {
    return `${prefix}${preservedSuffix}`
  }
  const context =
    args.cursorStorageContextKey &&
    args.cursorStorageContextKey !== 'native' &&
    args.cursorStorageContextKey !== args.executionHostId
      ? `:ctx-${stableIdentityHash(args.cursorStorageContextKey)}`
      : ''
  const collision = args.cursorBucketCollision
    ? `:bucket-${args.cursorBucketCollision}`
    : args.cursorLegacyPathCollision
      ? `:legacy-${stableIdentityHash(args.cursorLegacyPathCollision)}`
      : ''
  return `${prefix}${context}${collision}`
}

function cursorIdentitySuffix(previousId: string | undefined, sessionId: string): string | null {
  if (!previousId) {
    return null
  }
  const marker = `:cursor:${sessionId}`
  const markerIndex = previousId.lastIndexOf(marker)
  if (markerIndex < 0) {
    return null
  }
  const suffix = previousId.slice(markerIndex + marker.length)
  return suffix === '' || /^(?::(?:ctx|bucket|legacy)-[a-zA-Z0-9._-]+)+$/.test(suffix)
    ? suffix
    : null
}

function stableIdentityHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}
