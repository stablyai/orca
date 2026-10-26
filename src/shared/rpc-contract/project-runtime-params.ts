import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId
} from '../execution-host'

export const ProjectProviderIdentity = z.object({
  provider: z.literal('github'),
  owner: requiredString('Missing project owner'),
  repo: requiredString('Missing project repository'),
  host: OptionalString
})

// Client-minted runtime IDs address this machine, never a proxy. Persist local so clients share host identity
// and project/host deduplication works; readers project local back to each client’s own runtime ID.
// Legacy rows keep their existing stamps.
export const RequestedHostId = requiredString('Missing host ID').transform((value, ctx) => {
  const hostId = normalizeExecutionHostId(value)
  if (!hostId) {
    ctx.addIssue({ code: 'custom', message: 'Invalid host ID' })
    return z.NEVER
  }
  return parseExecutionHostId(hostId)?.kind === 'runtime' ? LOCAL_EXECUTION_HOST_ID : hostId
})

export const ProjectHostSetupExistingFolder = z.object({
  projectId: requiredString('Missing project ID'),
  projectProviderIdentity: ProjectProviderIdentity.optional(),
  hostId: RequestedHostId,
  path: requiredString('Missing project path'),
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  setupMethod: z.enum(['imported-existing-folder', 'cloned']).optional()
})

export const ProjectHostSetupClone = z.object({
  projectId: requiredString('Missing project ID'),
  projectProviderIdentity: ProjectProviderIdentity.optional(),
  hostId: RequestedHostId,
  url: requiredString('Missing clone URL'),
  destination: requiredString('Missing clone destination'),
  displayName: OptionalString
})

export const LocalWindowsRuntimePreference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit-global') }),
  z.object({ kind: z.literal('windows-host') }),
  z.object({ kind: z.literal('wsl'), distro: requiredString('Missing WSL distro') })
])

export const ProjectUpdate = z.object({
  projectId: requiredString('Missing project ID'),
  updates: z.object({
    localWindowsRuntimePreference: LocalWindowsRuntimePreference.optional()
  })
})

export const ProjectHostSetupCreate = z.object({
  projectId: requiredString('Missing project ID'),
  hostId: RequestedHostId,
  setupId: OptionalString,
  path: OptionalString,
  kind: z.enum(['git', 'folder']).optional(),
  displayName: OptionalString,
  worktreeBasePath: OptionalString,
  gitUsername: OptionalString,
  setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
  setupMethod: z.enum(['imported-existing-folder', 'cloned', 'provisioned']).optional()
})

// Why `hostId` is optional: older clients omit it, and older hosts strip it (first match by id).
export const ProjectHostSetupUpdate = z.object({
  setupId: requiredString('Missing setup ID'),
  hostId: RequestedHostId.optional(),
  updates: z.object({
    displayName: OptionalString,
    path: OptionalString,
    worktreeBasePath: OptionalString,
    setupState: z.enum(['ready', 'not-set-up', 'setting-up', 'error', 'unsupported']).optional(),
    setupMethod: z
      .enum(['legacy-repo', 'imported-existing-folder', 'cloned', 'provisioned'])
      .optional(),
    gitUsername: OptionalString,
    kind: z.enum(['git', 'folder']).optional()
  })
})

export const ProjectHostSetupDelete = z.object({
  setupId: requiredString('Missing setup ID'),
  hostId: RequestedHostId.optional(),
  force: z.boolean().optional()
})
