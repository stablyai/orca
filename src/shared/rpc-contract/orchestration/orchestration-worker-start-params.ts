import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'
import { agentSessionAdvisoryPolicySchema } from '../../agent-session/agent-session-advisory-policy'
import { agentSessionExecutionPolicySchema } from '../../agent-session/agent-session-execution-policy'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

export const WorkerStartParams = z
  .object({
    task: OptionalString,
    spec: OptionalString,
    taskTitle: OptionalString,
    deps: OptionalString,
    parent: OptionalString,
    on: OptionalString,
    run: OptionalString,
    from: requiredString('Missing --from'),
    worktree: OptionalString,
    name: OptionalString,
    repo: OptionalString,
    baseBranch: OptionalString,
    displayName: OptionalString,
    comment: OptionalString,
    setup: z.enum(['run', 'skip', 'inherit']).optional(),
    terminal: OptionalString,
    agent: OptionalString,
    model: OptionalWorkerLaunchPreference,
    effort: OptionalWorkerLaunchPreference,
    executionPolicy: agentSessionExecutionPolicySchema.optional(),
    advisoryPolicy: agentSessionAdvisoryPolicySchema.optional(),
    retryOf: OptionalString,
    timeoutMs: OptionalFiniteNumber,
    devMode: z.boolean().optional(),
    /** Only from the paired Orca coordinating this Run: its own ID for the Task this start creates or reopens. */
    adoptTaskId: OptionalString
  })
  .superRefine((params, ctx) => {
    if (
      params.executionPolicy &&
      (params.advisoryPolicy ||
        (!params.task && (!params.spec || !params.parent)) ||
        !params.worktree?.startsWith('id:') ||
        params.agent !== 'codex' ||
        params.model !== params.executionPolicy.model ||
        params.effort !== params.executionPolicy.effort ||
        [
          params.on,
          params.terminal,
          params.retryOf,
          params.adoptTaskId,
          params.setup,
          params.name,
          params.repo,
          params.baseBranch,
          params.displayName,
          params.comment,
          params.deps
        ].some((value) => value !== undefined))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executionPolicy'],
        message:
          'Bounded execution requires a fresh local Codex child, exact folder and policy selection, without reuse or setup.'
      })
    }
    if (
      params.advisoryPolicy &&
      (!params.spec ||
        !params.parent ||
        !params.worktree?.startsWith('id:') ||
        params.agent !== 'claude' ||
        !params.model ||
        !params.effort ||
        [
          params.task,
          params.on,
          params.terminal,
          params.retryOf,
          params.adoptTaskId,
          params.setup,
          params.name,
          params.repo,
          params.baseBranch,
          params.displayName,
          params.comment,
          params.deps
        ].some((value) => value !== undefined))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['advisoryPolicy'],
        message:
          'Advisors require a new child consultation, exact existing local folder, explicit Claude model and effort, and no reuse or setup.'
      })
    }
    if (!params.task && !params.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['task'],
        message: 'Missing --task or --spec'
      })
    }
    if (params.task && params.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spec'],
        message: '--task and --spec are mutually exclusive'
      })
    }
    // spec creates a new Task, so retryOf cannot refer to a prior Dispatch for it.
    if (params.retryOf && params.spec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryOf'],
        message:
          '--retry-of needs --task <task_id> naming the failed Task; --spec creates a new one'
      })
    }
  })
