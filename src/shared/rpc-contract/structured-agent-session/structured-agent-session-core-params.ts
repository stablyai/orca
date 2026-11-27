import * as z from 'zod'
import { AgentSessionSelectionSchema } from '../../agent-session/options/protocol/agent-session-execution-options'
import {
  SendBody,
  MAX_OPTION_LABEL,
  AgentSessionOptions
} from './structured-agent-session-message-params'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { AGENT_SESSION_ID_MAX_LENGTH as MAX_ID_LENGTH } from '../../agent-session/agent-session-wire'
import { CREATE_TAB_FIELDS } from './structured-agent-session-create-tab-params'
import { isStructuredAgentId } from '../../agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { normalizeExecutionHostId } from '../../execution-host/execution-host'
import { AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH as MAX_RESPONSE_OPTION_ID_LENGTH } from '../../agent-session/requests/prompts/agent-session-question-answer'
import { MutationEnvelope } from './structured-agent-session-mutation-envelope'
import { SOURCE_FIELDS, ResumeWriterAdmission } from './structured-agent-session-resume-params'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const ProviderHandle = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('codex'), threadId: Identifier('Invalid thread id') }).strict(),
    z
      .object({
        kind: z.literal('claude'),
        sessionId: Identifier('Invalid provider session id'),
        leafUuid: Identifier('Invalid leaf uuid').nullable()
      })
      .strict()
  ])
)

/** Host-registered agents; clients gate names beyond Claude/Codex on the registered-agents capability. */
export const StructuredAgent = lazyZodSchema(() =>
  z.string().refine(isStructuredAgentId, 'Invalid agent')
)

export const ExecutionHostId = lazyZodSchema(() =>
  z
    .string()
    .max(MAX_ID_LENGTH)
    .transform((value) => normalizeExecutionHostId(value))
    .refine((value): value is NonNullable<typeof value> => value !== null, {
      message: 'Invalid execution host id'
    })
)

export const ExecutionLocation = lazyZodSchema(() =>
  z
    .object({
      executionHostId: ExecutionHostId,
      wslDistro: Identifier('Invalid WSL distro').nullable(),
      workspaceId: Identifier('Invalid workspace id'),
      workspaceKind: z.enum(['git-worktree', 'folder'])
    })
    .strict()
)

export const AccountHome = lazyZodSchema(() =>
  z
    .object({
      variable: z.enum(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']),
      path: z.string().min(1).max(4096)
    })
    .strict()
)

/** Only Claude/Codex handles have wire forms; other agents attach through host-resolved intent. */
export const AttachParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      location: ExecutionLocation,
      provider: z.enum(['codex', 'claude']),
      agent: Identifier('Invalid agent'),
      accountHome: AccountHome,
      runtimeKind: z.literal('native'),
      providerHandle: ProviderHandle
    })
    .strict()
)

export const CreateSupportParams = lazyZodSchema(() =>
  z
    .object({
      worktree: Identifier('Invalid worktree selector'),
      agent: StructuredAgent,
      resumeFrom: ResumeWriterAdmission.optional()
    })
    .strict()
)

export const SendParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      retryUnknown: z.literal(true).optional(),
      /** Host-held draft while active; gate strict payloads on agent-session.queued-messages.v2.
       * Operation fingerprint only, never body fingerprint. */
      delivery: z.literal('queue-if-active').optional(),
      /** Preserve composer options until dispatch; requires agent-session.send-options.v1. Operation fingerprint only. */
      options: AgentSessionOptions.optional(),
      selection: AgentSessionSelectionSchema.optional(),
      // Strict payload: only hosts advertising the bound usage-limit send capability accept this.
      usageLimitContinuationOfTurnItemId: Identifier('Invalid source turn item id').optional(),
      body: SendBody
    })
    .strict()
    .refine(
      (value) => value.options === undefined || value.selection === undefined,
      'Choose options or selection'
    )
)

export const CreateIntentParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      worktree: Identifier('Invalid worktree selector'),
      agent: StructuredAgent,
      ...SOURCE_FIELDS,
      ...CREATE_TAB_FIELDS,
      /** Both fields require `agentSession.create.message.v1` on the executing host. */
      firstMessage: z
        .object({
          clientMessageId: Identifier('Invalid client message id'),
          body: SendBody,
          selection: AgentSessionSelectionSchema.optional()
        })
        .strict()
        .optional(),
      options: AgentSessionOptions.optional(),
      optionsMode: z.literal('replace-model-selection').optional()
    })
    .strict()
)

export const CreateParams = lazyZodSchema(() => z.union([AttachParams, CreateIntentParams]))

export const CancelParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      // Absent: stop whatever the conversation has in flight. Present: only if that turn is current.
      turnId: Identifier('Invalid turn id').optional(),
      scope: z.literal('background-tasks').optional(),
      taskId: Identifier('Invalid task id').optional(),
      prompt: z
        .object({
          itemId: Identifier('Invalid item id'),
          expectedRevision: z.number().int().positive()
        })
        .strict()
        .optional()
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.taskId !== undefined && value.scope !== 'background-tasks') {
        ctx.addIssue({ code: 'custom', message: 'A task id requires background-task scope' })
      }
      if (value.prompt !== undefined && value.scope === 'background-tasks') {
        ctx.addIssue({ code: 'custom', message: 'A prompt cannot use background-task scope' })
      }
      // A card with no running turn names only itself; the host routes it.
      if (value.turnId === undefined && value.scope !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'A background-task cancel names its turn' })
      }
    })
)

/** Queued draft actions require agent-session.queued-messages.v2; older hosts lack these methods. */
export const QueuedMessageActionParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      messageId: Identifier('Invalid queued message id')
    })
    .strict()
)

/** Resume dispatch after Stop/restart pauses; gated like queued draft actions. */
export const QueuedMessagesResumeParams = lazyZodSchema(() =>
  z.object({ envelope: MutationEnvelope }).strict()
)

export const RespondParams = lazyZodSchema(() =>
  z
    .object({
      envelope: MutationEnvelope,
      itemId: Identifier('Invalid item id'),
      /** Compare-and-set: the revision the client had on screen. */
      expectedRevision: z.number().int().positive(),
      optionId: Identifier('Invalid option id', MAX_RESPONSE_OPTION_ID_LENGTH)
    })
    .strict()
)

export const SetOptionParams = lazyZodSchema(() =>
  z.strictObject({
    envelope: MutationEnvelope,
    key: Identifier('Invalid option key'),
    value: z.string().max(MAX_OPTION_LABEL)
  })
)

export const OptionsParams = lazyZodSchema(() => z.object({ sessionId: SessionId }).strict())
