import type { RuntimeClientTarget } from '../../../../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner-contract'
import {
  getOrCreateStructuredReadOwner,
  structuredReadOwnerKey
} from './structured-agent-session-read-owner-registry'
import { createReadOwner } from './structured-agent-session-read-owner-create'
import { useAppStore } from '@/store'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'

export function activateStructuredAgentSessionReadOwner(
  owner: StructuredAgentSessionReadOwner,
  environmentId: string | null
): () => void {
  return owner.activate({
    getState: useAppStore.getState,
    subscribeRetryNow: (retry) =>
      environmentId ? subscribeRuntimeHostContactRegained(environmentId, retry) : () => {}
  })
}

export function getStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget | null,
  unroutableHost = ''
): StructuredAgentSessionReadOwner {
  const key = structuredReadOwnerKey(sessionId, target, unroutableHost)
  return getOrCreateStructuredReadOwner(key, () => createReadOwner(key, sessionId, target))
}
