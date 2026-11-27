import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalString, requiredNumber, requiredString } from '../rpc-param-primitives'

export const WorkspacePortScanParams = lazyZodSchema(() =>
  z.object({
    repoId: OptionalString
  })
)

export const WorkspacePortKillParams = lazyZodSchema(() =>
  z.object({
    repoId: OptionalString,
    pid: requiredNumber('Missing process id'),
    port: requiredNumber('Missing port')
  })
)

export const WorkspacePortProbePageParams = lazyZodSchema(() =>
  z.object({
    host: requiredString('Missing host'),
    port: requiredNumber('Missing port'),
    protocol: z.enum(['http', 'https'])
  })
)

export const WorkspacePortScanHostParams = lazyZodSchema(() =>
  z.object({
    worktree: requiredString('Missing worktree selector')
  })
)

export const WorkspacePortKillHostParams = lazyZodSchema(() =>
  z.object({
    worktree: requiredString('Missing worktree selector'),
    executionHostId: requiredString('Missing execution host'),
    pid: requiredNumber('Missing process id'),
    port: requiredNumber('Missing port')
  })
)
