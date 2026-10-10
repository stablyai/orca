import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../../../shared/structured-agent-session-surface-capabilities'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  forgetHostModelCatalogSnapshots,
  hostModelCatalogSnapshotAgents,
  preloadHostModelCatalogSnapshots
} from './host-model-catalog-snapshots'
import {
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from './host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from './local-runtime-capabilities'
import { localStructuredChatsInUse } from './local-structured-chats'
import type { RuntimeClientTarget } from './runtime-client-target'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

// The settings that change which account (or binary) a new chat lists under, as the host reads them.
const ACCOUNT_SETTINGS = [
  'activeCodexManagedAccountId',
  'activeCodexManagedAccountIdsByRuntime',
  'codexManagedAccounts',
  'activeClaudeManagedAccountId',
  'activeClaudeManagedAccountIdsByRuntime',
  'claudeManagedAccounts',
  'agentDefaultEnv',
  'agentCmdOverrides'
] as const satisfies readonly (keyof GlobalSettings)[]

const LOCAL = { kind: 'local' } as const

/** Agents this machine's chats were used with: a saved pick says so without starting any CLI. */
function localAgentsInUse(settings: AppState['settings']): string[] {
  return Object.entries(settings?.nativeChatSessionOptions ?? {})
    .filter(([, entry]) => typeof entry?.model === 'string' && entry.model.trim() !== '')
    .map(([agent]) => agent)
}

function readsSavedOnly(capabilities: readonly string[] | null | undefined): boolean {
  return capabilities?.includes(AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY) === true
}

// The registered-agent list each host was last preloaded from; a new list preloads again.
const preloadedFrom = new Map<string, unknown>()

/** Every agent the host registered, read saved-only so no agent's CLI starts. Nothing until the
 *  host's agents are learned (their arrival preloads), or when this list was read already and its
 *  answers were not dropped since (`again`). */
function preloadRegisteredAgents(
  target: RuntimeClientTarget,
  executionHostId: string,
  runtimeId: string | null,
  again: boolean
): Promise<void> {
  const agents = readHostStructuredAgentsForRuntime(executionHostId, runtimeId)
  if (!agents || (!again && preloadedFrom.get(executionHostId) === agents)) {
    return Promise.resolve()
  }
  preloadedFrom.set(executionHostId, agents)
  return preloadHostModelCatalogSnapshots(
    target,
    agents.map((row) => row.agent),
    { savedOnly: true }
  )
}

/** `again` after this machine's answers were dropped. Never then is an older runtime read: its read
 *  lists when nothing is saved. */
async function preloadLocal(again: boolean): Promise<void> {
  const { settings } = useAppStore.getState()
  if (!(await localStructuredChatsInUse(settings))) {
    return
  }
  const capabilities = await ensureLocalRuntimeCapabilities()
  if (readsSavedOnly(capabilities)) {
    await preloadRegisteredAgents(LOCAL, LOCAL_EXECUTION_HOST_ID, null, again)
  } else if (capabilities && !again) {
    // An older runtime lists when nothing is saved: only agents with a saved pick.
    await preloadHostModelCatalogSnapshots(LOCAL, localAgentsInUse(settings))
  }
}

function pairedHostStatus(environmentId: string): RuntimeStatus | null {
  return lastVerifiedRuntimeStatus(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  )
}

/** A paired host's lists again after contact returns: every registered agent from a host that reads
 *  saved-only, else only the agents this client already had an answer for. */
function reloadPairedHost(environmentId: string): void {
  const target = { kind: 'environment', environmentId } as const
  const answered = hostModelCatalogSnapshotAgents(target)
  forgetHostModelCatalogSnapshots(target)
  const status = pairedHostStatus(environmentId)
  if (status && readsSavedOnly(status.capabilities)) {
    const executionHostId = toRuntimeExecutionHostId(environmentId)
    void preloadRegisteredAgents(target, executionHostId, status.runtimeId, true)
  } else {
    void preloadHostModelCatalogSnapshots(target, answered)
  }
}

/** Preloads each host whose registered agents arrived (or changed) since its last preload. */
function preloadHostsWithNewAgents(): void {
  if (readsSavedOnly(readLocalRuntimeCapabilitiesOrUnknown())) {
    void preloadRegisteredAgents(LOCAL, LOCAL_EXECUTION_HOST_ID, null, false)
  }
  for (const environmentId of useAppStore.getState().runtimeStatusByEnvironmentId.keys()) {
    const executionHostId = toRuntimeExecutionHostId(environmentId)
    const status = pairedHostStatus(environmentId)
    if (!status || !readsSavedOnly(status.capabilities)) {
      continue
    }
    const target = { kind: 'environment', environmentId } as const
    void preloadRegisteredAgents(target, executionHostId, status.runtimeId, false)
  }
}

function accountSettingsChanged(state: AppState, previous: AppState): boolean {
  return (
    state.settings !== previous.settings &&
    ACCOUNT_SETTINGS.some((key) => state.settings?.[key] !== previous.settings?.[key])
  )
}

/**
 * Loads each host's saved model lists into the renderer before a chat pane asks: every agent the
 * host registered, read saved-only so no agent's CLI starts — this machine's once its runtime and
 * agents are known, a paired host's at connect and each time this client regains contact. An older
 * host, whose read lists when nothing is saved, is read only for agents with a saved pick (this
 * machine) or that it answered before (paired). An account or launch setting change drops this
 * machine's lists and reads them again for the new account. Returns the unsubscribe.
 */
export function installHostModelCatalogSnapshotsSync(): () => void {
  void preloadLocal(false)
  const stopLocal = subscribeLocalRuntimeCapabilitiesKnown(() => void preloadLocal(false))
  const stopAgents = subscribeHostStructuredAgents(preloadHostsWithNewAgents)
  const contactStops = new Map<string, () => void>()
  const watchPairedHosts = (statuses: AppState['runtimeStatusByEnvironmentId']): void => {
    for (const environmentId of statuses.keys()) {
      if (!contactStops.has(environmentId)) {
        contactStops.set(
          environmentId,
          subscribeRuntimeHostContactRegained(environmentId, () => reloadPairedHost(environmentId))
        )
      }
    }
  }
  watchPairedHosts(useAppStore.getState().runtimeStatusByEnvironmentId)
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
      watchPairedHosts(state.runtimeStatusByEnvironmentId)
    }
    if (accountSettingsChanged(state, previous)) {
      forgetHostModelCatalogSnapshots(LOCAL)
      void preloadLocal(true)
    }
  })
  return () => {
    stopLocal()
    stopAgents()
    stopStore()
    contactStops.forEach((stop) => stop())
    preloadedFrom.clear()
  }
}

export function useHostModelCatalogSnapshotsSync(): void {
  useEffect(() => installHostModelCatalogSnapshotsSync(), [])
}
