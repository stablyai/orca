import { z } from 'zod'
import type { AiVaultSession } from './ai-vault-types'
import { sessionFileExecutionNamespace } from './ai-vault-scope-cwd-match'
import { antigravitySessionOrigin } from './antigravity-session-origin'

export const CONVERSATION_NAVIGATION_CAPABILITY = 'ui.conversationPreferences.v1'
export const CONVERSATION_PROJECT_VISIBILITY_CAPABILITY = 'ui.conversationProjectVisibility.v1'
const Preference = z.object({ pinned: z.boolean().optional(), archived: z.boolean().optional() })
export const ConversationPreferencesSchema = z.object({
  revision: z.number().int().nonnegative().catch(0),
  entries: z.record(z.string().max(2048), Preference.catch({})).catch({}),
  hiddenProjects: z.record(z.string().max(2048), z.string().max(1024)).optional().catch(undefined)
})
export type ConversationPreferences = z.infer<typeof ConversationPreferencesSchema>
export type ConversationPreference = z.infer<typeof Preference>
const SetChatPreferenceParams = z
  .object({
    key: z.string().min(1).max(2048),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.pinned !== undefined || value.archived !== undefined)
export const SetConversationProjectVisibilityParams = z
  .object({
    projectKey: z.string().min(1).max(2048),
    label: z.string().min(1).max(1024),
    hidden: z.boolean()
  })
  .strict()
export const SetConversationPreferenceParams = z.union([
  SetChatPreferenceParams,
  SetConversationProjectVisibilityParams
])

export function conversationProjectVisibilityKey(host: string, projectKey: string): string {
  return JSON.stringify([host, projectKey])
}

export function normalizeConversationPreferences(value: unknown): ConversationPreferences {
  const result = ConversationPreferencesSchema.safeParse(value)
  return result.success ? result.data : { revision: 0, entries: {} }
}

export function conversationPreferenceKey(
  session: Pick<AiVaultSession, 'executionHostId' | 'structuredSession' | 'sessionId'> & {
    agent: string
    filePath?: string
    id?: string
  }
): string {
  const owner = [
    session.executionHostId,
    session.structuredSession ? 'structured' : session.agent,
    session.structuredSession?.sessionId ?? session.sessionId
  ]
  if (session.structuredSession) {
    return JSON.stringify(owner)
  }
  if (!session.filePath) {
    return JSON.stringify([...owner, 'unknown', session.id ?? session.sessionId])
  }
  const namespace = sessionFileExecutionNamespace(session.filePath)
  if (namespace === 'native' && session.agent !== 'antigravity') {
    return JSON.stringify(owner)
  }
  return JSON.stringify([
    ...owner,
    namespace,
    ...(session.agent === 'antigravity'
      ? [
          antigravitySessionOrigin(session.filePath),
          session.filePath
            .split(/[\\/]+/)
            .slice(0, -4)
            .join('/')
        ]
      : [])
  ])
}

export function updateConversationPreference(
  current: unknown,
  request: z.infer<typeof SetConversationPreferenceParams>
): ConversationPreferences {
  const state = normalizeConversationPreferences(current)
  const revision = Math.min(Number.MAX_SAFE_INTEGER, state.revision + 1)
  if ('projectKey' in request) {
    const hiddenProjects = { ...state.hiddenProjects }
    if (request.hidden) {
      hiddenProjects[request.projectKey] = request.label
    } else {
      delete hiddenProjects[request.projectKey]
    }
    return { ...state, revision, hiddenProjects }
  }
  const previous = state.entries[request.key] ?? {}
  return {
    ...state,
    revision,
    entries: {
      ...state.entries,
      [request.key]: {
        ...previous,
        ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
        ...(request.archived !== undefined ? { archived: request.archived } : {})
      }
    }
  }
}
