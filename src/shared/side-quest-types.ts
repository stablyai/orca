export const SIDE_QUEST_PROVIDERS = ['codex'] as const
export type SideQuestProvider = (typeof SIDE_QUEST_PROVIDERS)[number]

export const SIDE_QUEST_SESSION_STATUSES = ['starting', 'ready', 'error'] as const
export type SideQuestSessionStatus = (typeof SIDE_QUEST_SESSION_STATUSES)[number]

/** Durable pointer from an Orca terminal tab to its provider-owned conversation.
 * Messages stay in the provider transcript and are never copied into workspace state. */
export type SideQuestSessionReference = {
  /** Orca-owned stable identity used before and after a provider thread exists. */
  id: string
  provider: SideQuestProvider
  providerThreadId: string | null
  status: SideQuestSessionStatus
  error: string | null
  createdAt: number
  updatedAt: number
}
