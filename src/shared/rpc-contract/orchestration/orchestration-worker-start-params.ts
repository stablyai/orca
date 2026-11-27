import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'
import { CrossStoreParentRefSchema } from '../workspaces/cross-store-parent-params'

export const OptionalWorkerLaunchPreference = lazyZodSchema(() =>
  z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
    .optional()
)

export const WorkerStartParams = lazyZodSchema(() =>
  z
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
      retryOf: OptionalString,
      timeoutMs: OptionalFiniteNumber,
      devMode: z.boolean().optional(),
      /** What the creator started this worker for (`bot-item:<uid>`), checked by its owner before the
       *  start and kept on the Dispatch; opaque to orchestration. */
      origin: OptionalString,
      /** The question this worker is started to answer (`--for <message id>`), linked when the caller
       *  took it or reads the mailbox it sits in; otherwise the start goes ahead unlinked. */
      forQuestion: OptionalString,
      /** Only from the paired Orca coordinating this Run: its own ID for the Task this start creates or reopens. */
      adoptTaskId: OptionalString,
      /** Only from the paired Orca coordinating this Run: its own workspace, the parent of a new-child here. */
      crossStoreParent: CrossStoreParentRefSchema.optional(),
      /** Only from the paired Orca coordinating this Run: the start is in a chat lineage there, so it and
       *  the workers it starts start as chats here too. */
      chatLineage: z.literal(true).optional()
    })
    .superRefine((params, ctx) => {
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
)
