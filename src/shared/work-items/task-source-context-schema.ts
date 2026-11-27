import * as z from 'zod'
import { normalizeStoredTaskSourceContext, type TaskSourceContext } from './task-source-context'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const TaskSourceContextSchema = lazyZodSchema(() =>
  z.unknown().transform((value, ctx): TaskSourceContext => {
    const normalized = normalizeStoredTaskSourceContext(value)
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'Invalid task source context' })
      return z.NEVER
    }
    return normalized
  })
)
