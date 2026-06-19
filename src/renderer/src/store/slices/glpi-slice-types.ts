import type {
  GlpiConnectArgs,
  GlpiConnectionStatus,
  GlpiCreateTicketArgs,
  GlpiCreateTicketResult,
  GlpiFollowup,
  GlpiMutationResult,
  GlpiServerSelection,
  GlpiTicket,
  GlpiTicketFilter,
  GlpiTicketUpdate,
  GlpiWorkItemFilters
} from '../../../../shared/types'
import type { CacheEntry } from './github'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type GlpiOptions = {
  sourceContext?: TaskSourceContext | null
  serverId?: GlpiServerSelection | null
}

export type GlpiSlice = {
  glpiStatus: GlpiConnectionStatus
  glpiStatusChecked: boolean
  glpiStatusContextKey: string | null
  glpiTicketCache: Record<string, CacheEntry<GlpiTicket | null>>
  glpiListCache: Record<string, CacheEntry<GlpiTicket[]>>
  glpiFollowupsCache: Record<string, CacheEntry<GlpiFollowup[]>>

  checkGlpiConnection: () => Promise<void>
  connectGlpi: (args: GlpiConnectArgs) => Promise<{ ok: boolean; error?: string }>
  disconnectGlpi: (serverId?: string) => Promise<void>
  selectGlpiServer: (serverId: GlpiServerSelection) => Promise<void>
  testGlpiConnection: (serverId?: string) => Promise<{ ok: boolean; error?: string }>
  listGlpiWorkItems: (
    filter: GlpiTicketFilter,
    limit: number,
    filters?: GlpiWorkItemFilters,
    options?: GlpiOptions
  ) => Promise<GlpiTicket[]>
  fetchGlpiTicket: (
    id: number,
    serverId?: string | null,
    options?: GlpiOptions
  ) => Promise<GlpiTicket | null>
  fetchGlpiFollowups: (
    id: number,
    serverId?: string | null,
    options?: GlpiOptions
  ) => Promise<GlpiFollowup[]>
  addGlpiFollowupComment: (
    id: number,
    content: string,
    serverId?: string | null,
    options?: GlpiOptions
  ) => Promise<GlpiMutationResult>
  updateGlpiTicketDetail: (
    id: number,
    updates: GlpiTicketUpdate,
    serverId?: string | null,
    options?: GlpiOptions
  ) => Promise<GlpiMutationResult>
  createGlpiTicket: (
    args: GlpiCreateTicketArgs,
    options?: GlpiOptions
  ) => Promise<GlpiCreateTicketResult>
}
