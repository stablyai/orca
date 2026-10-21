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

export const WorkspacePortScanHostParams = z.object({
  worktree: requiredString('Missing worktree selector')
})

export const WorkspacePortKillHostParams = z.object({
  worktree: requiredString('Missing worktree selector'),
  executionHostId: requiredString('Missing execution host'),
  pid: requiredNumber('Missing process id'),
  port: requiredNumber('Missing port')
})
