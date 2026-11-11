import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

/** A saved runtime environment served by a recipe VM, by name or id. */
export const RecipeVmWakeParams = z.object({
  environment: requiredString('Missing required --environment')
})
