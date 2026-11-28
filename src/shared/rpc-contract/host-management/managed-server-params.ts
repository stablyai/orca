import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'

/** A managed Orca server on this host, by environment name or id. */
export const ManagedServerSelector = lazyZodSchema(() =>
  z.object({
    selector: requiredString('Missing required --environment')
  })
)

export const ManagedServerRecover = lazyZodSchema(() =>
  ManagedServerSelector.extend({
    // Restores the prelaunch snapshot over state a rejected build changed.
    acceptChangedState: z.boolean().optional()
  })
)

export const ManagedServerUpdate = lazyZodSchema(() =>
  ManagedServerSelector.extend({
    // Restarts over live terminals when the update would otherwise defer.
    force: z.boolean().optional(),
    // With force: the confirmed `--yes` that terminals orcad runs itself end when they cannot be counted.
    endInProcessTerminals: z.boolean().optional()
  })
)
