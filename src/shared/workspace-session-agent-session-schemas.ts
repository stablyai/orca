import { z } from 'zod'
import {
  normalizeAgentProviderSession,
  PROVIDER_SESSION_VALUE_MAX_LENGTH,
  RESUMABLE_TUI_AGENTS
} from './agent-session-resume'
import {
  normalizePromptInteractionHistory,
  type AgentStatusPromptInteraction
} from './agent-status-types'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './types'

const terminalTabIdSchema = z.string().min(1)

const agentProviderSessionSchema = z.preprocess(
  (raw) => normalizeAgentProviderSession(raw) ?? undefined,
  z.object({
    key: z.enum(['session_id', 'conversation_id', 'session_path']),
    id: z.string().min(1).max(PROVIDER_SESSION_VALUE_MAX_LENGTH)
  })
)

const promptInteractionSchema: z.ZodType<AgentStatusPromptInteraction> = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  observedAt: z.number().finite().positive(),
  agentType: z.string().optional()
})

const promptInteractionHistorySchema = z
  .preprocess(
    (raw) => normalizePromptInteractionHistory(raw),
    z.array(promptInteractionSchema).optional()
  )
  .optional()

const sleepingAgentSessionRecordSchema = z.object({
  paneKey: z.string().refine((value) => value.length > 0),
  tabId: terminalTabIdSchema.optional(),
  worktreeId: z.string().min(1),
  agent: z.enum(RESUMABLE_TUI_AGENTS),
  providerSession: agentProviderSessionSchema,
  prompt: z.string(),
  state: z.enum(['working', 'blocked', 'waiting', 'done']),
  capturedAt: z.number().finite().positive(),
  updatedAt: z.number().finite().positive(),
  terminalTitle: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  promptInteractions: promptInteractionHistorySchema,
  connectionId: z.string().nullable().optional(),
  resumeAvailable: z.boolean().optional(),
  origin: z.enum(['worktree-sleep', 'quit', 'live']).optional()
})

export const sleepingAgentSessionsByPaneKeySchema = z.preprocess((raw) => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const cleaned: Record<string, z.infer<typeof sleepingAgentSessionRecordSchema>> = {}
  for (const [paneKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = sleepingAgentSessionRecordSchema.safeParse(value)
    if (parsed.success && parsed.data.paneKey === paneKey) {
      cleaned[paneKey] = parsed.data
    }
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}, z.record(z.string(), sleepingAgentSessionRecordSchema).optional())

const archivedForkableAgentSessionRecordSchema = z.object({
  paneKey: z.string().refine((value) => value.length > 0),
  tabId: terminalTabIdSchema.optional(),
  worktreeId: z.string().min(1),
  agent: z.custom<TuiAgent>((value) => isTuiAgent(value)),
  providerSession: agentProviderSessionSchema,
  prompt: z.string(),
  state: z.literal('done'),
  archivedAt: z.number().finite().positive(),
  updatedAt: z.number().finite().positive(),
  terminalTitle: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  promptInteractions: promptInteractionHistorySchema,
  archiveReason: z.enum(['retained-dismissed', 'quit'])
})

export const archivedForkableAgentSessionsByPaneKeySchema = z.preprocess((raw) => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const cleaned: Record<string, z.infer<typeof archivedForkableAgentSessionRecordSchema>> = {}
  for (const [paneKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = archivedForkableAgentSessionRecordSchema.safeParse(value)
    if (parsed.success && parsed.data.paneKey === paneKey) {
      cleaned[paneKey] = parsed.data
    }
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}, z.record(z.string(), archivedForkableAgentSessionRecordSchema).optional())
