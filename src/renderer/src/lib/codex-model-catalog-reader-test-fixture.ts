import { vi } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'

export const { fetchCodexModelCatalogListing } = await vi.importActual<{
  fetchCodexModelCatalogListing(input: {
    connection: {
      request: (
        method: string,
        params?: Record<string, unknown>,
        options?: { timeoutMs?: number | null; onReply?: () => void }
      ) => Promise<unknown>
    }
    timeoutMs?: number
    deadlineMs?: number
    cwd?: string
  }): Promise<{
    models: AgentSessionModelOption[]
    complete?: boolean
    configured?: { model?: string; effort?: string }
    listedServiceTiers?: readonly string[]
  }>
}>('../../../main/codex/codex-structured-model-catalog')
