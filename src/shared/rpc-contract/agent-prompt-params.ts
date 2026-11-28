import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { Identifier } from './structured-agent-session/structured-agent-session-identifiers'

export const AGENT_PROMPT_OPTION_ROLES = ['approve', 'approve-always', 'deny', 'other'] as const

export const AgentPromptOptionRole = lazyZodSchema(() => z.enum(AGENT_PROMPT_OPTION_ROLES))

export const PendingAgentPromptOption = lazyZodSchema(() =>
  z
    .object({
      optionId: z.string().min(1),
      label: z.string().min(1),
      role: AgentPromptOptionRole
    })
    .strict()
)

export const PendingAgentPromptTarget = lazyZodSchema(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('chat'), sessionId: z.string().min(1) }).strict(),
    z.object({ type: z.literal('terminal'), terminal: z.string().min(1) }).strict()
  ])
)

/** One live approval or question a paired client can answer. `detail` is a tool plus a short input. */
export const PendingAgentPrompt = lazyZodSchema(() =>
  z
    .object({
      promptId: z.string().min(1),
      kind: z.enum(['permission', 'question']),
      target: PendingAgentPromptTarget,
      worktreeId: z.string().min(1),
      agent: z.string().min(1),
      title: z.string().min(1),
      detail: z.string().min(1).max(300).optional(),
      options: z.array(PendingAgentPromptOption).min(1),
      createdAt: z.number().finite()
    })
    .strict()
)

export type AgentPromptOptionRole = z.infer<typeof AgentPromptOptionRole>
export type PendingAgentPrompt = z.infer<typeof PendingAgentPrompt>

export const AgentPromptListPendingParams = lazyZodSchema(() => z.object({}).strict())

export const AgentPromptListPendingResult = lazyZodSchema(() =>
  z
    .object({
      prompts: z.array(PendingAgentPrompt)
    })
    .strict()
)

export const AgentPromptRespondParams = lazyZodSchema(() =>
  z
    .object({
      promptId: Identifier('Invalid prompt id', 2048),
      optionId: Identifier('Invalid option id'),
      clientOperationId: Identifier('Invalid client operation id')
    })
    .strict()
)

export const AgentPromptRespondResultSchema = lazyZodSchema(() =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true) }).strict(),
    z
      .object({
        ok: z.literal(false),
        reason: z.enum(['stale', 'not_found', 'rejected', 'unavailable'])
      })
      .strict()
  ])
)

export type AgentPromptRespondResult = z.infer<typeof AgentPromptRespondResultSchema>
