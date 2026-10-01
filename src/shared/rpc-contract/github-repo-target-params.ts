import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const RepoSelector = z.object({
  repo: requiredString('Missing repo selector')
})

export const SlugRepo = z.object({
  owner: requiredString('Missing owner'),
  repo: requiredString('Missing repo'),
  // Why: Enterprise host identity must survive RPC parsing; Zod strips
  // undeclared fields before the runtime can host-qualify gh requests.
  host: OptionalString
})
