import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'

/** `vmRecipe.list`: one repo's environment recipes, or every local repo's when omitted. */
export const VmRecipeList = z.object({ repo: OptionalString })
