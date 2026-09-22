import { z } from 'zod'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

export type DispatchMutationMessageType =
  | 'worker_done'
  | 'heartbeat'
  | 'escalation'
  | 'decision_gate'

export function isDispatchMutationMessageType(
  type: string | undefined
): type is DispatchMutationMessageType {
  return (
    type === 'worker_done' ||
    type === 'heartbeat' ||
    type === 'escalation' ||
    type === 'decision_gate'
  )
}

export function getLifecycleGroupRecipientError(type: DispatchMutationMessageType): string {
  return `${type} messages belong to one exact Dispatch and cannot target a group address.`
}

export const CheckParams = z
  .object({
    terminal: OptionalString,
    terminalPaneKey: OptionalString,
    unread: OptionalBoolean,
    peek: OptionalBoolean,
    // Why: `all` surfaces every message and skips mark-read; legacy encoding was the `{unread: false}` trick (design doc §3.2/§3.3).
    all: OptionalBoolean,
    types: OptionalString,
    format: OptionalBoolean,
    // Why: one-release RPC compatibility only; the public CLI uses --format because no terminal input is injected.
    inject: OptionalBoolean,
    ack: OptionalString,
    compatibilityAck: OptionalString,
    compatibilityQuestionAck: OptionalString,
    compatibilityCliCommand: z.enum(['orca', 'orca-ide', 'orca-dev']).optional(),
    run: OptionalString,
    wait: OptionalBoolean,
    timeoutMs: OptionalFiniteNumber
  })
  .superRefine((params, ctx) => {
    // Why: CLI encodes --peek as {peek:true, unread:false} for pre-peek runtimes, so that pair is one mode, not a conflict.
    const modes = [
      params.unread === true,
      params.peek === true,
      params.all === true || (params.unread === false && params.peek !== true)
    ].filter(Boolean)
    if (modes.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose at most one message read mode: --unread, --peek, or --all.'
      })
    }
  })

export const ReplyParams = z.object({
  id: requiredString('Missing --id'),
  body: requiredString('Missing --body'),
  from: OptionalString,
  run: OptionalString
})

export const InboxParams = z.object({
  limit: OptionalFiniteNumber,
  // Why: filters the inbox to a handle so inbox and check --all give agreeing results (design doc §3.3).
  terminal: OptionalString
})

export const TaskCreateParams = z.object({
  spec: requiredString('Missing --spec'),
  taskTitle: OptionalString,
  displayName: OptionalString,
  deps: OptionalString,
  parent: OptionalString,
  callerTerminalHandle: OptionalString,
  run: OptionalString
})

export const TaskListParams = z.object({
  status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']).optional(),
  ready: OptionalBoolean,
  // Why: server-side truncation keeps --brief cheap over SSH/relay instead of shipping full specs the CLI throws away.
  brief: OptionalBoolean,
  run: OptionalString,
  callerTerminalHandle: OptionalString
})

export const DispatchParams = z.object({
  task: requiredString('Missing --task'),
  // Why: --to is optional so --dry-run can preview without a target; the handler enforces presence before any side-effecting work.
  to: OptionalString,
  from: OptionalString,
  inject: OptionalBoolean,
  dryRun: OptionalBoolean,
  returnPreamble: OptionalBoolean,
  devMode: OptionalBoolean,
  run: OptionalString
})

export const DispatchShowParams = z.object({
  task: OptionalString,
  preamble: OptionalBoolean,
  from: OptionalString,
  devMode: OptionalBoolean
})

export const AskParams = z
  .object({
    to: OptionalString,
    question: OptionalString,
    resume: OptionalString,
    options: OptionalString,
    timeoutMs: OptionalFiniteNumber,
    from: OptionalString,
    run: OptionalString,
    compatibilityCliCommand: z.enum(['orca', 'orca-ide', 'orca-dev']).optional(),
    compatibilityWindowsCommand: z.enum(['orca', 'orca-ide']).optional()
  })
  .superRefine((params, ctx) => {
    if ((params.question ? 1 : 0) + (params.resume ? 1 : 0) !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one of --question or --resume.'
      })
    }
  })

export const ResetParams = z
  .object({
    all: OptionalBoolean,
    tasks: OptionalBoolean,
    messages: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    const selectedScopeCount = [params.all, params.tasks, params.messages].filter(
      (scope) => scope === true
    ).length
    if (selectedScopeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
      })
    }
  })
