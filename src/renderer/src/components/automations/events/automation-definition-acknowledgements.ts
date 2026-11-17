import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

type DefinitionAcknowledgement = { target: RuntimeClientTarget; automationId: string }
const listeners = new Set<(ack: DefinitionAcknowledgement) => void>()

/** Fence open readers synchronously before a mutation helper returns its acknowledgement. */
export function acknowledgeAutomationDefinition(
  target: RuntimeClientTarget,
  automationId: string
): void {
  for (const listener of listeners) {
    listener({ target, automationId })
  }
}

export function subscribeAutomationDefinitionAcknowledgements(
  listener: (ack: DefinitionAcknowledgement) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
