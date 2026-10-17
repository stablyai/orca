import type { AgentSessionUnavailable } from './agent-session-availability'

export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

export type AgentSessionModelOption = {
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  efforts: AgentSessionOptionChoice[]
  resolvedModel?: string | null
  /** False distinguishes an unobserved menu from a provider-reported empty menu. */
  effortsKnown?: false
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
  /** Whether the model runs Approve for me; absent is unknown, which neither offers nor launches it. */
  supportsAutoMode?: boolean
  /** Service tiers the provider lists for this model besides its standard one, each valued by the
   *  provider's own tier id. Absent means unknown; a client that reads it offers one speed choice
   *  (`default` for standard) in place of the Fast toggle. */
  serviceTiers?: AgentSessionOptionChoice[]
}

export type AgentSessionFastModeState = 'off' | 'cooldown' | 'on'

export type AgentSessionFastModeSupport = {
  supported: boolean
  /** Provider-authored or host-normalized reason code; presentation may ignore unknown values. */
  reason?: string
}

export type AgentSessionChoiceCatalog = {
  authority: 'discovery' | 'session'
  scopeId: string
  models: AgentSessionModelOption[]
  complete: boolean
  freshForMs: number
  configured?: { model?: string; effort?: string }
  fastModeSupport?: AgentSessionFastModeSupport
}

/**
 * The host's model catalog for an agent, answered from its own store and
 * never through a session's queue. `unknown` means this host has no listing
 * for the key yet — the client keeps its static seed. Additive read-only
 * surface: an older host simply lacks the method.
 */
export type AgentSessionModelCatalogResult = {
  choiceCatalog?: AgentSessionChoiceCatalog
  /** The host is running the listing this answer is waiting on (its first for the account, or
   *  the probe re-checking `unavailable`); a `waitForListing` read answers when it lands. Absent
   *  from a host that predates it; such a host sends it only with `unknown`. */
  listingInProgress?: true
  /** Why no chat can start under the account, as the host's probe last found it. Absent is
   *  unknown, which shows nothing; an older host never sends it. */
  unavailable?: AgentSessionUnavailable
} & (
  | { origin: 'unknown' }
  | {
      /** What produced the listing; any age is served, `fetchedAt` carries it. */
      origin: 'live-session' | 'probe'
      models: AgentSessionModelOption[]
      fastModeSupport?: AgentSessionFastModeSupport
      fetchedAt: number
      /** The listed default is the model a new chat here launches with: the agent's listing names
       *  its configured model and no workspace config can replace it. Absent from an older host. */
      listingNamesConfiguredModel?: boolean
      /** The named default holds in every workspace: the agent reads no project config for its
       *  model, so an answer naming no workspace serves any new chat. Absent from an older host. */
      defaultHoldsInEveryWorkspace?: true
    }
)
