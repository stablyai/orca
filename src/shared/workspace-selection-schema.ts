import { z } from 'zod'
import { salvagedOptional } from './zod-salvage'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

export const executionHostIdSchema = z.custom<ExecutionHostId>(
  (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
)

export const activeWorkspaceOwnerSchema = salvagedOptional(
  'activeWorkspaceOwner',
  z
    .object({
      worktreeId: z.string().min(1),
      publisherHostId: executionHostIdSchema,
      executionHostId: executionHostIdSchema,
      instanceId: z.string().min(1).optional()
    })
    .nullable()
)
