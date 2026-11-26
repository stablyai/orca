import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'

/** A saved runtime environment served by a recipe VM, by name or id. */
export const RecipeVmWakeParams = lazyZodSchema(() =>
  z.object({
    environment: requiredString('Missing required --environment')
  })
)
