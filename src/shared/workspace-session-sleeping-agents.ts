import { z } from 'zod'
import {
  getAgentResumeArgv,
  normalizeAgentProviderSession,
  RESUMABLE_TUI_AGENTS
} from './agent-session-resume'
import { AGENT_EFFORT_LEVEL } from './agent-effort-level'
import { isValidTerminalTabId } from './terminal-tab-id'
import { normalizeMainAgentStatusField } from './agent-status-types'
import { salvagingRecord } from './zod-salvage'

const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')

const agentProviderSessionSchema = z.preprocess(
  (raw) => normalizeAgentProviderSession(raw) ?? undefined,
  z.object({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string().min(1).max(512),
    // Pi resume requires its persisted authoritative transcript path.
    transcriptPath: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    effort: z.string().regex(AGENT_EFFORT_LEVEL).optional()
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

export const sleepingAgentLaunchConfigBaseSchema = z.object({
  agentCommand: z.string().optional(),
  agentArgs: z.string(),
  agentEnv: sleepingAgentLaunchEnvSchema,
  // AI Vault scans arbitrary OMP roots; retain the exact resume locator for cold restore.
  ompResumeFilePath: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024)
    .refine((value) => !hasUnsafeLaunchEnvChars(value))
    .optional()
})

export const sleepingAgentLaunchConfigSchema = z.preprocess((raw) => {
  const parsed = sleepingAgentLaunchConfigBaseSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}, sleepingAgentLaunchConfigBaseSchema.optional())

export const sleepingAgentSessionRecordSchema = z
  .object({
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
    interrupted: z.boolean().optional(),
    // A malformed value drops the field, never the record.
    mainAgent: z.unknown().transform(normalizeMainAgentStatusField).optional(),
    connectionId: z.string().nullable().optional(),
    launchConfig: sleepingAgentLaunchConfigSchema.optional(),
    origin: z.enum(['worktree-sleep', 'quit', 'live']).optional(),
    restoreOnTabOpenOnly: z.boolean().optional()
  })
  .refine(
    (record) => getAgentResumeArgv(record.agent, record.providerSession) !== null,
    // Resume must use a supported provider key; Pi also requires its transcript path.
    { message: 'provider session is not resumable for this agent', path: ['providerSession'] }
  )

export const sleepingAgentSessionsByPaneKeySchema = salvagingRecord(
  z.string().refine((paneKey) => !isUnsafeObjectKey(paneKey)),
  sleepingAgentSessionRecordSchema,
  (paneKey, record) => record.paneKey === paneKey
).transform((records) => (Object.keys(records).length > 0 ? records : undefined))
