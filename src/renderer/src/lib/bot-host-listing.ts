// Which paired servers list bots here, kept in step with the server catalog and each server's connection.
import {
  runtimeStatusSubscriptionsFor,
  subscribeStoreWithStatuses,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-subscriptions'
import { BOTS_MOBILE_RUNTIME_CAPABILITY } from '../../../shared/bot-runtime-capabilities'
import type { BotChangeScope } from '../../../shared/bots/bot-change-scope'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import type { AppState } from '@/store/types'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  readBotHostState,
  readLiveBotHostIds,
  readUpdateNeededBotHosts,
  setBotHostListing,
  type BotHostListing,
  type BotHostState
} from './bot-catalog-snapshot'
import {
  markKeptBotHostDirty,
  readKeptBotHostList,
  retainKeptBotHostLists,
  setKeptBotHomesReader
} from './bot-host-kept-lists'
import { keptBotHomes } from './bot-host-kept-homes'
import { retainListedBotGroupHosts } from './bot-group-catalog-snapshot'
import { emitBotsChangedWindowEvent } from './bots-changed-window-event'

type BotHostListingStoreState = Pick<
  AppState,
  'runtimeEnvironments' | 'runtimeEnvironmentCatalogHydrated' | 'folderWorkspaces'
>

export type BotHostListingInput = BotHostListingStoreState & {
  runtimeStatusByEnvironmentId: RuntimeStatuses
}

type HostRead = {
  state: (hostId: ExecutionHostId) => BotHostState | null
  updateNeeded: readonly ExecutionHostId[]
}

/**
 * Each paired server that serves bots is listed while connected, and stays listed from its last
 * read while disconnected, kept across restarts. An older server is not listed; it asks for an update instead. A server
 * whose status isn't known yet keeps what it had. In a paired web window this app's own runtime is
 * the server, so only the server is listed.
 */
export function computeBotHostListing(
  input: BotHostListingInput,
  previous: HostRead,
  { webClient }: { webClient: boolean }
): BotHostListing {
  const hosts: BotHostListing['hosts'][number][] = webClient
    ? []
    : [{ hostId: LOCAL_EXECUTION_HOST_ID, state: 'live' }]
  const updateNeeded: ExecutionHostId[] = []
  // Test stores and early startup may not have the server catalog yet.
  for (const environment of input.runtimeEnvironments ?? []) {
    const hostId = toRuntimeExecutionHostId(environment.id)
    const entry = input.runtimeStatusByEnvironmentId?.get(environment.id)
    const connection = runtimeHostConnectionStateForEntry(entry)
    const connected = connection === 'connected' || connection === 'workspace-window-closed'
    const status = connected ? lastVerifiedRuntimeStatus(entry) : null
    if (status?.capabilities?.includes(BOTS_MOBILE_RUNTIME_CAPABILITY)) {
      hosts.push({ hostId, state: 'live' })
    } else if (status) {
      updateNeeded.push(hostId)
    } else if (previous.state(hostId) !== null) {
      hosts.push({ hostId, state: connected ? 'live' : 'offline' })
    } else if (previous.updateNeeded.includes(hostId)) {
      updateNeeded.push(hostId)
    }
  }
  return { hosts, updateNeeded }
}

/**
 * Keeps the bot hosts in step with the app store. A server that comes back, or is newly listed,
 * re-reads through its own bots-changed event, so every bot view reads that one server again.
 */
export function syncBotHostListing(input: BotHostListingInput, webClient: boolean): void {
  if (input.runtimeEnvironmentCatalogHydrated) {
    retainKeptBotHostLists(
      new Map(
        (input.runtimeEnvironments ?? []).map((env) => [
          toRuntimeExecutionHostId(env.id),
          // The server's key and its pairing: a re-pair to another server under the same id changes it.
          `${env.hostKeyFingerprint ?? ''}|${env.pairingRevision ?? ''}`
        ])
      )
    )
  }
  const listing = computeBotHostListing(
    input,
    {
      // A server not listed yet this session, but read before, is listed from that read.
      state: (hostId) =>
        readBotHostState(hostId) ?? (readKeptBotHostList(hostId) ? 'offline' : null),
      updateNeeded: readUpdateNeededBotHosts()
    },
    { webClient }
  )
  const becameLive = setBotHostListing(listing)
  retainListedBotGroupHosts()
  for (const hostId of becameLive) {
    emitBotsChangedWindowEvent(hostId)
  }
}

/** A paired server's bots changed, or its stream came back: every bot view re-reads that server, if listed. */
export function emitPairedBotsChanged(environmentId: string, scope?: BotChangeScope): void {
  const hostId = toRuntimeExecutionHostId(environmentId)
  if (readBotHostState(hostId) === 'live') {
    emitBotsChangedWindowEvent(hostId, scope)
  }
}

/** Starts following the store; local-only windows never pass the reference gate, so they do no work. */
export function installBotHostListing(
  store: {
    getState: () => BotHostListingInput
    subscribe: (
      listener: (state: BotHostListingInput, previous: BotHostListingInput) => void
    ) => () => void
  },
  webClient: boolean
): () => void {
  const sync = (state: BotHostListingStoreState, statuses: RuntimeStatuses): void =>
    syncBotHostListing(
      { ...pickListingState(state), runtimeStatusByEnvironmentId: statuses },
      webClient
    )
  sync(store.getState(), runtimeStatusSubscriptionsFor(store).readStatuses())
  // Homes are read once per flush; a catalog change only marks the connected servers dirty.
  setKeptBotHomesReader((hostId, list) =>
    keptBotHomes(hostId, list, selectFolderWorkspaces(store.getState()) ?? [])
  )
  return subscribeStoreWithStatuses(store, (state, previous, statuses, previousStatuses) => {
    if (selectFolderWorkspaces(state) !== selectFolderWorkspaces(previous)) {
      readLiveBotHostIds().forEach(markKeptBotHostDirty)
    }
    if (
      state.runtimeEnvironments === previous.runtimeEnvironments &&
      statuses === previousStatuses &&
      state.runtimeEnvironmentCatalogHydrated === previous.runtimeEnvironmentCatalogHydrated
    ) {
      return
    }
    sync(state, statuses)
  })
}

function pickListingState(state: BotHostListingStoreState): BotHostListingStoreState {
  return {
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    folderWorkspaces: selectFolderWorkspaces(state)
  }
}
