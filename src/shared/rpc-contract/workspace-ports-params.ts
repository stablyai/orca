import { z } from 'zod'
import { OptionalString, requiredNumber } from './rpc-param-primitives'

export const WorkspacePortScanParams = z.object({
  repoId: OptionalString
})

export const WorkspacePortKillParams = z.object({
  repoId: OptionalString,
  pid: requiredNumber('Missing process id'),
  port: requiredNumber('Missing port')
})
