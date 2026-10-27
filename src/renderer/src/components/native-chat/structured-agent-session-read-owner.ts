import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner-contract'
import {
  getOrCreateStructuredReadOwner,
  structuredReadOwnerKey
} from './structured-agent-session-read-owner-registry'
import { createReadOwner } from './structured-agent-session-read-owner-create'

export type {
  StructuredAgentSessionReadSnapshot,
  StructuredAgentSessionReadOwner
} from './structured-agent-session-read-owner-contract'

export {
  findStructuredAgentSessionReadOwner,
  retireStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner-registry'

export function getStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner {
  const key = structuredReadOwnerKey(sessionId, target)
  return getOrCreateStructuredReadOwner(key, () => createReadOwner(key, sessionId, target))
}
