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
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
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

/** Preload every registered agent saved-only without starting CLIs. Wait for host registration; skip previously read unchanged lists unless again. */
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

/** Reload after local answers drop; never read older runtimes here because missing saved lists would start listing. */
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

/** Preload host-saved lists before chat pickers render, without starting CLIs: local after runtime/agent discovery, paired at connect/reconnect. Older hosts permit only saved-pick local agents or previously answered paired agents. Account/launch-setting changes invalidate and reload local lists. Returns unsubscribe. */
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
