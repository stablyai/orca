import type { MachineProviderVerb } from './machine-provider-command'
import type { ProviderMachineState } from './machine-provider-protocol'

const CONFIRMED_STATES: Partial<Record<MachineProviderVerb, readonly ProviderMachineState[]>> = {
  create: ['creating', 'running'],
  wake: ['running', 'waking'],
  sleep: ['sleeping', 'stopping'],
  archive: ['archived', 'stopping']
}

/** Lifecycle verbs must report the state they moved to; anything else is unconfirmed. */
export function isConfirmedMachineTransition(
  verb: MachineProviderVerb,
  state: ProviderMachineState
): boolean {
  // Why never: only a `deleted`/`not-found` answer or a read that finds nothing proves a delete.
  if (verb === 'delete') {
    return false
  }
  const confirmed = CONFIRMED_STATES[verb]
  return confirmed ? confirmed.includes(state) : true
}
