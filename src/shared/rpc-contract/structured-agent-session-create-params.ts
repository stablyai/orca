import { z } from 'zod'
import { AgentSessionSelectionSchema } from '../agent-session-execution-options'
import { isStructuredAgentId } from '../agent-session-provider-handle-encoding'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { MutationEnvelope } from './structured-agent-session-mutation-envelope'
import { SendBody, AgentSessionOptions } from './structured-agent-session-message-params'
import { CREATE_TAB_FIELDS } from './structured-agent-session-create-tab-params'

/** Host-registered agents; clients gate names beyond Claude/Codex on the registered-agents capability. */
export const StructuredAgent = z.string().refine(isStructuredAgentId, 'Invalid agent')

/** Identity only: derive transcript/account paths host-side so clients cannot choose imported files or credential directories. */
export const ResumeSource = z
  .object({
    providerSessionId: Identifier('Invalid provider session id'),
    cliSource: z
      .object({
        workspaceId: Identifier('Invalid workspace id'),
        paneKey: Identifier('Invalid pane key')
      })
      .strict()
      .optional()
  })
  .strict()

export const CreateIntentFields = z
  .object({
    envelope: MutationEnvelope,
    worktree: Identifier('Invalid worktree selector'),
    agent: StructuredAgent,
    resumeFrom: ResumeSource.optional(),
    forkFrom: z
      .object({
        sessionId: SessionId,
        itemId: Identifier('Invalid branch item id'),
        expectedEpoch: Identifier('Invalid journal epoch')
      })
      .strict()
      .optional(),
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

export const CreateIntentParams = CreateIntentFields.refine(
  (value) =>
    value.forkFrom === undefined ||
    (value.agent === 'codex' &&
      value.resumeFrom === undefined &&
      value.firstMessage === undefined &&
      value.options === undefined &&
      value.optionsMode === undefined),
  'A Codex branch inherits its parent settings and cannot include a message or resume source'
)
