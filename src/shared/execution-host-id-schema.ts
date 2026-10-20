import { z } from 'zod'
import { parseExecutionHostId, type ExecutionHostId } from './execution-host'

export const executionHostIdSchema = z.custom<ExecutionHostId>(
  (value) => typeof value === 'string' && Boolean(parseExecutionHostId(value))
)
