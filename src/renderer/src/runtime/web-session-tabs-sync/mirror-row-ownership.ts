// One workspace can hold mirrored rows from several paired runtimes at once — an SSH host's server
// for its terminals and another desktop's app for a browser tab it hosts there (#31983). A
// runtime's frame speaks only for the rows that runtime owns; rows owned by another live runtime
// are left for that runtime's own frames to keep or retire.

import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Tab } from '../../../../shared/tab-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getRemoteRuntimePtyEnvironmentId } from '../runtime-terminal-stream'
import type { WebSessionTabsSyncState } from './state'
import { environmentIdsMirroringLocalTab } from './tracking-mappings'

/**
 * The sync state is the app store at runtime; minimal assemblies omit the catalog, and then every
 * runtime a row names counts as live.
 */
export type MirrorRowOwnershipState = WebSessionTabsSyncState &
  Partial<
    Pick<
      AppState,
      'removedRuntimeEnvironmentIds' | 'runtimeEnvironments' | 'runtimeEnvironmentCatalogSettled'
    >
  >

/** A runtime that can still publish: not removed, and listed once the catalog has settled. */
function isLiveEnvironment(state: MirrorRowOwnershipState, environmentId: string): boolean {
  if (state.removedRuntimeEnvironmentIds?.has(environmentId)) {
    return false
  }
  if (state.runtimeEnvironmentCatalogSettled !== true || !state.runtimeEnvironments) {
    return true
  }
  return state.runtimeEnvironments.some((environment) => environment.id === environmentId)
}

/**
 * A mirrored terminal belongs to the runtime its pane bindings name — the one whose PTYs it
 * streams. One still awaiting its first handle belongs to the runtimes whose last applied frames
 * published it. A frame may not retire a row that only another live runtime owns.
 */
export function isMirroredTerminalOfAnotherEnvironment(
  state: MirrorRowOwnershipState,
  tab: TerminalTab,
  environmentId: string
): boolean {
  const owners = new Set<string>()
  for (const ptyId of [
    tab.ptyId,
    ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})
  ]) {
    const owner = ptyId ? getRemoteRuntimePtyEnvironmentId(ptyId) : null
    if (owner && isLiveEnvironment(state, owner)) {
      owners.add(owner)
    }
  }
  if (owners.size === 0) {
    for (const owner of environmentIdsMirroringLocalTab(tab.worktreeId, tab.id)) {
      if (isLiveEnvironment(state, owner)) {
        owners.add(owner)
      }
    }
  }
  return owners.size > 0 && !owners.has(environmentId)
}

/** A chat names its host; this machine's or another live paired runtime's chat is theirs to retire. */
export function isAgentSessionTabOfAnotherHost(
  state: MirrorRowOwnershipState,
  tab: Pick<Tab, 'executionHostId'>,
  publisherExecutionHostId: string
): boolean {
  if (!tab.executionHostId || tab.executionHostId === publisherExecutionHostId) {
    return false
  }
  // Why: only this machine or a live paired runtime can publish chats; any other stamp is stale.
  const host = parseExecutionHostId(tab.executionHostId)
  return (
    host?.kind === 'local' ||
    (host?.kind === 'runtime' && isLiveEnvironment(state, host.environmentId))
  )
}
