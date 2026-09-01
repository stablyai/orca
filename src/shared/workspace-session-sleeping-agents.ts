import { z } from 'zod'
import {
  getAgentResumeArgv,
  normalizeAgentProviderSession,
  RESUMABLE_TUI_AGENTS
} from './agent-session-resume'
import { isValidTerminalTabId } from './terminal-tab-id'
import { salvagingRecord } from './zod-salvage'
import type { TuiAgent } from './types'

const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')

const agentProviderSessionSchema = z.preprocess(
  (raw) => normalizeAgentProviderSession(raw) ?? undefined,
  z.object({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string().min(1).max(512),
    // Why: Pi resumes by its authoritative session file, so dropping this
    // field during hydration makes an otherwise valid record unusable.
    transcriptPath: z.string().min(1).optional()
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
  agentEnv: sleepingAgentLaunchEnvSchema,
  // Why: AI Vault can scan arbitrary OMP roots, so cold restore must retain
  // the exact provider resume locator instead of reconstructing its store.
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

// The originally requested identity: a built-in base or a custom id
// ('custom-agent:<base>:<uuid>'). Kept lenient — an unparseable value drops
// only the field (the read-side falls back to `agent`), never the whole record.
const requestedAgentSchema = z.preprocess(
  (raw) =>
    typeof raw === 'string' && raw.length > 0 && raw.length <= 256 && !hasUnsafeLaunchEnvChars(raw)
      ? raw
      : undefined,
  z.string().optional()
)

const sleepingAgentSessionRecordSchema = z
  .object({
    paneKey: z.string().refine((value) => value.length > 0),
    tabId: terminalTabIdSchema.optional(),
    worktreeId: z.string().min(1),
    agent: z.enum(RESUMABLE_TUI_AGENTS),
    // The requested identity resolved to its resumable base; the ownership key and
    // provider resume argv key on this, never on `requestedAgent`. Optional during
    // the additive migration window — the transform below back-fills legacy records.
    requestedAgent: requestedAgentSchema,
    baseAgent: z.enum(RESUMABLE_TUI_AGENTS).optional(),
    providerSession: agentProviderSessionSchema,
    prompt: z.string(),
    state: z.enum(['working', 'blocked', 'waiting', 'done']),
    capturedAt: z.number().finite().positive(),
    updatedAt: z.number().finite().positive(),
    terminalTitle: z.string().optional(),
    lastAssistantMessage: z.string().optional(),
    interrupted: z.boolean().optional(),
    connectionId: z.string().nullable().optional(),
    launchConfig: sleepingAgentLaunchConfigSchema.optional(),
    origin: z.enum(['worktree-sleep', 'quit', 'live']).optional(),
    automaticResumeBlockedBy: z.enum(['legacy-orchestration-worker']).optional(),
    restoreOnTabOpenOnly: z.boolean().optional()
  })
  .refine(
    (record) => getAgentResumeArgv(record.agent, record.providerSession) !== null,
    // Why: a hydrated record must be directly resumable; Pi additionally needs
    // its persisted transcript path and agents must use their supported key.
    { message: 'provider session is not resumable for this agent', path: ['providerSession'] }
  )
  // Deterministic on-read migration: a legacy record carries only `agent`, which
  // is already its resumable base, so back-fill both identity fields from it. New
  // records persist their own receipt-derived requestedAgent/baseAgent.
  .transform((record) => ({
    ...record,
    baseAgent: record.baseAgent ?? record.agent,
    // Cast: the persisted string is validated leniently above and re-validated at
    // read time (resolveTuiAgentBaseAgent returns null for anything unresolvable),
    // so a non-conforming id degrades to the base rather than failing the parse.
    requestedAgent: (record.requestedAgent ?? record.agent) as TuiAgent
  }))

export const sleepingAgentSessionsByPaneKeySchema = salvagingRecord(
  z.string().refine((paneKey) => !isUnsafeObjectKey(paneKey)),
  sleepingAgentSessionRecordSchema,
  (paneKey, record) => record.paneKey === paneKey
).transform((records) => (Object.keys(records).length > 0 ? records : undefined))
