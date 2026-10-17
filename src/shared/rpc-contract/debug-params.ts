import { z } from 'zod'

const MAX_SELECTOR_LENGTH = 4_096
const MAX_PATH_LENGTH = 4_096
const MAX_NAME_LENGTH = 1_024
const MAX_HASH_LENGTH = 128
export const DEBUG_MAX_EXPRESSION_BYTES = 8 * 1_024
export const DEBUG_MAX_STACK_LEVELS = 200
export const DEBUG_MAX_VARIABLE_DEPTH = 3
export const DEBUG_MAX_WAIT_MS = 120_000
export const DEBUG_MAX_BREAKPOINTS = 1_000
/** Longer variable values and eval results are cut to this many UTF-8 bytes, with truncated: true. */
export const DEBUG_MAX_VALUE_BYTES = 64 * 1_024

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length
// Why bytes, not chars: a condition or expression is sent to the adapter as UTF-8.
const code = (label: string, min = 0) =>
  z
    .string()
    .min(min)
    .max(DEBUG_MAX_EXPRESSION_BYTES)
    .refine(
      (value) => utf8Bytes(value) <= DEBUG_MAX_EXPRESSION_BYTES,
      `${label} must be at most ${DEBUG_MAX_EXPRESSION_BYTES} bytes`
    )
const dapId = z.number().int().nonnegative()
const line = z.number().int().min(1).max(10_000_000)
const debugPath = z.string().min(1).max(MAX_PATH_LENGTH)

export const DebugWorktreeParams = z.object({
  worktree: z.string().min(1).max(MAX_SELECTOR_LENGTH)
})

export const DebugStartParams = DebugWorktreeParams.extend({
  config: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  file: debugPath.optional(),
  line: line.optional(),
  expectedHash: z.string().min(1).max(MAX_HASH_LENGTH).optional()
})

export const DebugThreadParams = DebugWorktreeParams.extend({
  threadId: dapId.optional()
})

export const DebugStackParams = DebugThreadParams.extend({
  levels: z.number().int().min(1).max(DEBUG_MAX_STACK_LEVELS).optional()
})

export const DebugVariablesParams = DebugWorktreeParams.extend({
  frameId: dapId.optional(),
  variablesReference: z.number().int().positive().optional(),
  depth: z.number().int().min(0).max(DEBUG_MAX_VARIABLE_DEPTH).optional()
})

export const DebugEvaluateParams = DebugWorktreeParams.extend({
  expression: code('expression', 1),
  frameId: dapId.optional()
})

export const DebugBreakpointLocationParams = DebugWorktreeParams.extend({
  path: debugPath,
  line
})

export const DebugBreakpointSetParams = DebugBreakpointLocationParams.extend({
  condition: code('condition').optional(),
  hitCondition: code('hitCondition').optional(),
  logMessage: code('logMessage').optional()
})

export const DebugEventsParams = DebugWorktreeParams.extend({
  since: z.number().int().nonnegative().optional()
})

export const DEBUG_WAIT_FOR = ['stopped', 'terminated', 'either'] as const

export const DebugWaitParams = DebugWorktreeParams.extend({
  for: z.enum(DEBUG_WAIT_FOR),
  timeoutMs: z.number().int().min(0).max(DEBUG_MAX_WAIT_MS),
  /** A state after this seq counts; defaults to the caller's last start, restart, continue, step or pause. */
  since: z.number().int().nonnegative().optional()
})
