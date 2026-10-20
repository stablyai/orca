import { z } from 'zod'
import { parseRoutableExecutionHostId, type ExecutionHostId } from '../execution-host'

// Only this host answers: `local`, or the `runtime:` alias a paired client reaches it through.
// The spelling must already be canonical so an alias is never rewritten into another one.
export function isRepositoryAddScriptRouteHostId(value: string): value is ExecutionHostId {
  const parsed = parseRoutableExecutionHostId(value)
  return parsed?.id === value && (parsed.kind === 'local' || parsed.kind === 'runtime')
}

const RouteHostId = z.string().refine(isRepositoryAddScriptRouteHostId, 'Invalid host ID')

export const RepositoryAddScriptRequestParam = z.strictObject({ hostId: RouteHostId })

export const RepositoryAddScriptIdentityParams = z.strictObject({
  token: z.string().min(1),
  hostId: RouteHostId,
  repoId: z.string().min(1)
})

export const RepositoryAddScriptDecideParams = z.strictObject({
  ...RepositoryAddScriptIdentityParams.shape,
  decision: z.enum(['run', 'skip'])
})
