import { z } from 'zod'
import { OptionalString, requiredNumber, requiredString } from './rpc-param-primitives'

export const WorkspacePortScanParams = z.object({
  repoId: OptionalString
})

export const WorkspacePortKillParams = z.object({
  repoId: OptionalString,
  pid: requiredNumber('Missing process id'),
  port: requiredNumber('Missing port')
})

export const WorkspacePortProbePageParams = z.object({
  host: requiredString('Missing host'),
  port: requiredNumber('Missing port'),
  protocol: z.enum(['http', 'https'])
})

export const WorkspacePortScanHostParams = z.object({
  worktree: requiredString('Missing worktree selector')
})

export const WorkspacePortKillHostParams = z.object({
  worktree: requiredString('Missing worktree selector'),
  executionHostId: requiredString('Missing execution host'),
  pid: requiredNumber('Missing process id'),
  port: requiredNumber('Missing port')
})

export const WorkspaceServerScopeParams = z.object({
  worktree: z.string().min(1),
  executionHostId: z.string().min(1)
})
export const WorkspaceServerStartParams = WorkspaceServerScopeParams.extend({
  port: z.number().int().min(1).max(65535),
  name: z.string().min(1).max(256),
  command: z.string().min(1).max(16384),
  cwd: z.string().min(1)
})
export const WorkspaceServerStopParams = WorkspaceServerScopeParams.extend({
  port: z.number().int().min(1).max(65535),
  runId: z.string().min(1)
})
