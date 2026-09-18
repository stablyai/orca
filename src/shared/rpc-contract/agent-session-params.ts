import { z } from 'zod'
import { isValidTerminalTabId } from '../terminal-tab-id'
import {
  RESUMABLE_TUI_AGENTS,
  getAgentResumeArgv,
  hasUnsafeProviderSessionIdChars
} from '../agent-session-resume'
import { parseAgentSessionOperationTimestamp } from '../agent-session-host-authority'
import type {
  RuntimeCreateAgentSessionRequest,
  RuntimeEnsureAgentSessionRequest
} from '../agent-session-host-authority'
import { isTuiAgent } from '../tui-agent-config'

export const MAX_WORKTREE_SELECTOR_LENGTH = 32_768

export const MAX_TRANSCRIPT_PATH_BYTES = 16 * 1024

export const MAX_PROMPT_BYTES = 256 * 1024

export const MAX_AGENT_ARGS_BYTES = 16 * 1024

export const MAX_LAUNCH_PREFERENCE_LENGTH = 512

export const StrictNonEmptyString = (max: number, message: string) =>
  z
    .string()
    .min(1, message)
    .max(max, message)
    .refine((value) => value === value.trim(), `${message}; surrounding whitespace is invalid`)

export const WorktreeSelector = StrictNonEmptyString(
  MAX_WORKTREE_SELECTOR_LENGTH,
  'Invalid worktree selector'
)

export const Presentation = z.enum(['background', 'focused'])

export const Placement = z
  .object({
    tabId: z
      .string()
      .min(1)
      .max(512)
      .refine(isValidTerminalTabId, 'Invalid terminal tab ID')
      .optional(),
    leafId: z.string().min(1).max(128).optional()
  })
  .strict()
  .refine((value) => value.tabId !== undefined || value.leafId !== undefined, {
    message: 'Placement must include a tab or leaf ID'
  })

export const LaunchPreferences = z
  .object({
    model: StrictNonEmptyString(
      MAX_LAUNCH_PREFERENCE_LENGTH,
      'Invalid model preference'
    ).optional(),
    effort: StrictNonEmptyString(
      MAX_LAUNCH_PREFERENCE_LENGTH,
      'Invalid effort preference'
    ).optional(),
    mode: StrictNonEmptyString(MAX_LAUNCH_PREFERENCE_LENGTH, 'Invalid mode preference').optional()
  })
  .strict()

export const PromptDelivery = z.enum(['auto-submit', 'draft'])

export const AgentArgs = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_AGENT_ARGS_BYTES,
    'Agent arguments are too large'
  )
  .nullable()

export const OmpResumeFilePath = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), 'Invalid OMP resume path')
  .refine(
    (value) =>
      !hasUnsafeProviderSessionIdChars(value) &&
      Buffer.byteLength(value, 'utf8') <= MAX_TRANSCRIPT_PATH_BYTES,
    'Invalid OMP resume path'
  )

export const ProviderSession = z
  .object({
    key: z.enum(['session_id', 'conversation_id']),
    id: StrictNonEmptyString(512, 'Invalid provider session ID').refine(
      (value) => !value.startsWith('-') && !hasUnsafeProviderSessionIdChars(value),
      'Invalid provider session ID'
    ),
    transcriptPath: z
      .string()
      .min(1)
      .refine((value) => value === value.trim(), 'Invalid transcript path')
      .refine(
        (value) =>
          !hasUnsafeProviderSessionIdChars(value) &&
          Buffer.byteLength(value, 'utf8') <= MAX_TRANSCRIPT_PATH_BYTES,
        'Invalid transcript path'
      )
      .optional()
  })
  .strict()

export const AutomaticEnsure = z
  .object({
    kind: z.literal('automatic'),
    sleepingCheckpointId: z
      .string()
      .min(32)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    presentation: Presentation.optional()
  })
  .strict()

export const ExplicitEnsure = z
  .object({
    kind: z.literal('explicit'),
    worktree: WorktreeSelector,
    agent: z.enum(RESUMABLE_TUI_AGENTS),
    providerSession: ProviderSession,
    ompResumeFilePath: OmpResumeFilePath.optional(),
    agentArgs: AgentArgs.optional(),
    launchPreferences: LaunchPreferences.optional(),
    presentation: Presentation.optional(),
    placement: Placement.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ompResumeFilePath !== undefined && value.agent !== 'omp') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ompResumeFilePath'],
        message: 'OMP resume path requires the OMP agent'
      })
    }
    if (getAgentResumeArgv(value.agent, value.providerSession, value.ompResumeFilePath) === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerSession'],
        message: 'Provider session is not resumable for this agent'
      })
    }
  })

export const EnsureAgentSessionParams: z.ZodType<RuntimeEnsureAgentSessionRequest> =
  z.discriminatedUnion('kind', [AutomaticEnsure, ExplicitEnsure])

export const CreateAgentSessionParams: z.ZodType<RuntimeCreateAgentSessionRequest> = z
  .object({
    clientOperationId: z
      .string()
      .refine(
        (value) => parseAgentSessionOperationTimestamp(value) !== null,
        'Invalid agent operation ID'
      ),
    worktree: WorktreeSelector,
    agent: z.string().refine(isTuiAgent, 'Unknown agent preset'),
    prompt: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value, 'utf8') <= MAX_PROMPT_BYTES,
        'Prompt is too large'
      )
      .optional(),
    promptDelivery: PromptDelivery.optional(),
    agentArgs: AgentArgs.optional(),
    launchPreferences: LaunchPreferences.optional(),
    startupCwd: z.string().min(1).max(MAX_WORKTREE_SELECTOR_LENGTH).optional(),
    presentation: Presentation.optional(),
    placement: Placement.optional(),
    viewMode: z.enum(['terminal', 'chat']).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.promptDelivery === 'draft' && !value.prompt?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Draft delivery requires a non-empty prompt'
      })
    }
  })
