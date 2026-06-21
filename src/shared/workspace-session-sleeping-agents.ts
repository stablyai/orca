import { z } from 'zod'
import { normalizeAgentProviderSession, RESUMABLE_TUI_AGENTS } from './agent-session-resume'
import { isValidTerminalTabId } from './terminal-tab-id'

const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')

const agentProviderSessionSchema = z.preprocess(
  (raw) => normalizeAgentProviderSession(raw) ?? undefined,
  z.object({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string().min(1).max(512)
  })
)

function hasUnsafeLaunchEnvChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function isUnsafeObjectKey(value: string): boolean {
  return value === '__proto__' || value === 'constructor' || value === 'prototype'
}

const sleepingAgentLaunchEnvSchema = z.preprocess(
  (raw) => {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined
    }
    const cleaned: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const trimmedKey = key.trim()
      if (
        trimmedKey.length === 0 ||
        isUnsafeObjectKey(trimmedKey) ||
        trimmedKey.includes('=') ||
        hasUnsafeLaunchEnvChars(trimmedKey) ||
        typeof value !== 'string' ||
        value.includes('\0')
      ) {
        return undefined
      }
      cleaned[trimmedKey] = value
    }
    return { ...cleaned }
  },
  z.record(z.string(), z.string())
)

const sleepingAgentLaunchConfigBaseSchema = z.object({
  agentCommand: z.string().optional(),
  agentArgs: z.string(),
  agentEnv: sleepingAgentLaunchEnvSchema
})

export const sleepingAgentLaunchConfigSchema = z.preprocess((raw) => {
  const parsed = sleepingAgentLaunchConfigBaseSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}, sleepingAgentLaunchConfigBaseSchema.optional())

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
  connectionId: z.string().nullable().optional(),
  launchConfig: sleepingAgentLaunchConfigSchema.optional(),
  origin: z.enum(['worktree-sleep', 'quit', 'live']).optional()
})

export const sleepingAgentSessionsByPaneKeySchema = z.preprocess((raw) => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }

  const cleaned: Record<string, z.infer<typeof sleepingAgentSessionRecordSchema>> = Object.create(
    null
  )
  for (const [paneKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isUnsafeObjectKey(paneKey)) {
      continue
    }
    const parsed = sleepingAgentSessionRecordSchema.safeParse(value)
    if (parsed.success && parsed.data.paneKey === paneKey) {
      cleaned[paneKey] = parsed.data
    }
  }

  return Object.keys(cleaned).length > 0 ? { ...cleaned } : undefined
}, z.record(z.string(), sleepingAgentSessionRecordSchema).optional())
