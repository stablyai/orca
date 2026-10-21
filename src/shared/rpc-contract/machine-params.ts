import { z } from 'zod'
import type { MachineProviderKey } from '../machine-inventory'
import { MACHINE_ID_PATTERN } from '../machine-provider-command'
import { OptionalBoolean } from './rpc-param-primitives'

const providerKey = z.custom<MachineProviderKey>(
  (value) => typeof value === 'string' && /^plugin:.+\/[^/]+$/.test(value),
  'Missing or invalid machine provider'
)

/** Every provider, or one; `refresh` asks providers instead of returning the cache. */
export const MachinesList = z.object({
  // Validated like MachineSelector's: a malformed key is refused, not read as "every provider".
  providerKey: providerKey.optional(),
  refresh: OptionalBoolean
})

export const MachineSelector = z.object({
  providerKey,
  machineId: z.string().regex(MACHINE_ID_PATTERN, 'Missing or invalid machine id')
})
