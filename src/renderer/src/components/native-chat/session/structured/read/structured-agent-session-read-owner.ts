import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner-contract'
import {
  getOrCreateStructuredReadOwner,
  structuredReadOwnerKey
} from './structured-agent-session-read-owner-registry'
import { createReadOwner } from './structured-agent-session-read-owner-create'

export function getStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget | null,
  unroutableHost = ''
): StructuredAgentSessionReadOwner {
  const key = structuredReadOwnerKey(sessionId, target, unroutableHost)
  return getOrCreateStructuredReadOwner(key, () => createReadOwner(key, sessionId, target))
}
