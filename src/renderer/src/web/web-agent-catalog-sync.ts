// Why: paired web has no local agent catalog, so it mirrors the host's env-free
// revisioned snapshot and re-projects it into the local snapshot shape the desktop
// catalog UI already consumes — one renderer code path, read-only here (authoring
// stays desktop preload IPC). An old host that publishes no catalog degrades to the
// built-in agents rather than an empty list or a rejected promise.
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  AgentCatalogProjectionError,
  AgentCatalogSnapshot,
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent,
  SyncedCustomTuiAgent
} from '../../../shared/agent-catalog-snapshot'
import {
  MAX_AGENT_CATALOG_PROJECTION_BYTES,
  MAX_LOCAL_AGENT_CATALOG_BYTES
} from '../../../shared/custom-tui-agent-fields'

/** The host snapshot or its oversize projection error; both carry version+revision. */
export type WebAgentCatalogValue = AgentCatalogSnapshot | AgentCatalogProjectionError

export type WebAgentCatalogSyncDeps = {
  /** Full envelope so an old host's `method_not_found` can pick the legacy path. */
  call: (method: string, params?: unknown) => Promise<RuntimeRpcResponse<unknown>>
  isPaired: () => boolean
  /** Feeds settings.onChanged so `useLocalAgentCatalog` refetches after a change. */
  onRevisionApplied: (revision: number) => void
}

export type WebAgentCatalogSync = {
  getLocal: () => Promise<LocalAgentCatalogSnapshot>
  /** Host announced a new catalog revision: drop the cache and refetch. */
  announceRevision: (revision: number) => void
}

function readyRow(agent: Extract<SyncedCustomTuiAgent, { status: 'ready' }>): LocalCustomTuiAgent {
  return {
    status: 'ready',
    definition: {
      id: agent.id,
      baseAgent: agent.baseAgent,
      label: agent.label,
      ...(agent.commandOverride ? { commandOverride: agent.commandOverride } : {}),
      args: agent.args,
      syncEnv: agent.syncEnv
    },
    // Env never crosses the wire, so its size is unknowable here; no UI reads it.
    envSummary: { entryCount: 0, bytes: 0 },
    // `launch-reported` means stock base detection cannot vouch for the row and
    // only the launch on the execution host establishes availability — keep it
    // out of `baseline-stock` so clients don't gate it on detection.
    availabilityReason: agent.commandOverride
      ? 'configured-executable'
      : agent.availabilityCheck === 'launch-reported'
        ? 'custom-path'
        : 'baseline-stock'
  }
}

function repairRow(
  agent: Extract<SyncedCustomTuiAgent, { status: 'repair-required' }>
): LocalCustomTuiAgent {
  return {
    status: 'repair-required',
    id: agent.id,
    baseAgent: agent.baseAgent,
    label: agent.label,
    // Repair tokens are host-local and paired web cannot author: no draft path.
    repairToken: '',
    issues: [],
    rawBytes: 0,
    draftAvailability: 'too-large'
  }
}

/** Built-in-only fallback: no custom agents, nothing disabled, no stored default. */
function builtInOnlySnapshot(revision: number): LocalAgentCatalogSnapshot {
  return {
    version: 1,
    revision,
    defaultAgent: null,
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: [],
    repairIssues: [],
    projection: { status: 'ready', bytes: 0, maxBytes: MAX_AGENT_CATALOG_PROJECTION_BYTES },
    localStorage: { status: 'ready', bytes: 0, maxBytes: MAX_LOCAL_AGENT_CATALOG_BYTES }
  }
}

export function projectWebAgentCatalog(
  value: WebAgentCatalogValue | null
): LocalAgentCatalogSnapshot {
  if (!value) {
    return builtInOnlySnapshot(0)
  }
  if ('code' in value) {
    return {
      ...builtInOnlySnapshot(value.revision),
      projection: { status: 'too-large', bytes: value.maxBytes, maxBytes: value.maxBytes }
    }
  }
  const customAgents = value.customAgents.map((agent) =>
    agent.status === 'ready' ? readyRow(agent) : repairRow(agent)
  )
  return {
    version: 1,
    revision: value.revision,
    defaultAgent: value.defaultAgent,
    disabledAgents: [...value.disabledAgents],
    customAgents,
    deletedCustomAgents: [...value.deletedCustomAgents],
    repairIssues: [],
    projection: { status: 'ready', bytes: 0, maxBytes: MAX_AGENT_CATALOG_PROJECTION_BYTES },
    localStorage: { status: 'ready', bytes: 0, maxBytes: MAX_LOCAL_AGENT_CATALOG_BYTES },
    ...(value.migrationBlocked ? { migrationBlocked: value.migrationBlocked } : {})
  }
}

function parseCatalogValue(raw: unknown): WebAgentCatalogValue | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const candidate = raw as { version?: unknown; revision?: unknown }
  if (candidate.version !== 1 || typeof candidate.revision !== 'number') {
    return null
  }
  return raw as WebAgentCatalogValue
}

function readCatalogField(result: unknown): unknown {
  return (result as { agentCatalog?: unknown } | null)?.agentCatalog
}

export function createWebAgentCatalogSync(deps: WebAgentCatalogSyncDeps): WebAgentCatalogSync {
  let cached: WebAgentCatalogValue | null = null
  let loading: Promise<WebAgentCatalogValue | null> | null = null
  let generation = 0

  // null = transient failure (keep whatever is cached); { value: null } = this host
  // publishes no catalog, so the built-in fallback is the honest answer.
  const fetchValue = async (): Promise<{ value: WebAgentCatalogValue | null } | null> => {
    try {
      const dedicated = await deps.call('settings.agentCatalog.get')
      if (dedicated.ok) {
        return { value: parseCatalogValue(readCatalogField(dedicated.result)) }
      }
      if (dedicated.error.code !== 'method_not_found') {
        return null
      }
    } catch {
      return null
    }
    try {
      // Old host: the catalog ships only piggybacked on settings.get.
      const legacy = await deps.call('settings.get')
      return legacy.ok ? { value: parseCatalogValue(readCatalogField(legacy.result)) } : null
    } catch {
      return null
    }
  }

  const load = (): Promise<WebAgentCatalogValue | null> => {
    if (loading) {
      return loading
    }
    const token = generation
    const pending = fetchValue().then(
      (outcome) => {
        if (loading === pending) {
          loading = null
        }
        // A revision announcement during the fetch invalidated this result.
        if (outcome && token === generation) {
          cached = outcome.value
        }
        return cached
      },
      () => {
        if (loading === pending) {
          loading = null
        }
        return cached
      }
    )
    loading = pending
    return pending
  }

  return {
    getLocal: async () => {
      if (!deps.isPaired()) {
        return projectWebAgentCatalog(null)
      }
      return projectWebAgentCatalog(cached ?? (await load()))
    },
    announceRevision: (revision) => {
      if (!deps.isPaired() || (cached !== null && cached.revision >= revision)) {
        return
      }
      // Keep the last-known catalog until the refetch lands: a failed refresh must
      // not blank out custom agents the host still has.
      generation += 1
      loading = null
      void load().then(() => deps.onRevisionApplied(revision))
    }
  }
}
