import type { AppState } from '@/store/types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { keyedListsMatch } from '@/store/record-transitions/keyed-list-match'
import { aliasKey } from './orchestration-row-identities'

const EMPTY: Record<string, never> = {}
let visits = 0
export function terminalProvenanceVisits(): number {
  return visits
}
type TerminalInputs = Partial<Pick<AppState, 'unifiedTabsByWorktree' | 'ptyIdsByTabId'>> & {
  tabsByWorktree?: Record<string, readonly { id: string; ptyId?: string | null }[]>
}
let terminalCache:
  | {
      inputs: TerminalInputs
      hosts: Map<string, string | null>
      ptys: Map<string, string | null>
      /** A terminal tab's host by bare tab id, which is how a pane key names it. */
      tabs: Map<string, string | null>
    }
  | undefined

// Why: only rows whose identity, host or pty changed can move provenance; title writes never do.
function terminalProvenanceInputsMatch(state: TerminalInputs, previous: TerminalInputs): boolean {
  return (
    keyedListsMatch(state.ptyIdsByTabId, previous.ptyIdsByTabId, (a, b) => a === b) &&
    keyedListsMatch(
      state.unifiedTabsByWorktree,
      previous.unifiedTabsByWorktree,
      (a, b) =>
        a.contentType === b.contentType &&
        a.worktreeId === b.worktreeId &&
        a.entityId === b.entityId &&
        a.executionHostId === b.executionHostId
    ) &&
    keyedListsMatch(
      state.tabsByWorktree,
      previous.tabsByWorktree,
      (a, b) => a.id === b.id && a.ptyId === b.ptyId
    )
  )
}

/** Which host runs each terminal tab, from its recorded host and its PTY ids. */
export function terminalProvenance(state: TerminalInputs) {
  const inputs: TerminalInputs = {
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId
  }
  if (terminalCache && terminalProvenanceInputsMatch(inputs, terminalCache.inputs)) {
    // The same object keeps the orchestration projection cached across title-only writes.
    terminalCache.inputs = inputs
    return terminalCache
  }
  const hosts = new Map<string, string | null>()
  const tabsById = new Map<string, string | null>()
  const ptys = new Map<string, string | null>()
  const merge = (map: Map<string, string | null>, key: string, host: string | null) => {
    map.set(key, map.has(key) && map.get(key) !== host ? null : host)
  }
  const ptyHost = (id?: string | null): string | null | undefined => {
    if (!id) {
      return undefined
    }
    const remote = parseRemoteRuntimePtyId(id)
    return remote?.environmentId
      ? toRuntimeExecutionHostId(remote.environmentId)
      : isRemoteRuntimePtyId(id)
        ? null
        : undefined
  }
  for (const [tab, ids] of Object.entries(state.ptyIdsByTabId ?? EMPTY)) {
    for (const id of ids) {
      visits++
      const host = ptyHost(id)
      if (host !== undefined) {
        merge(ptys, tab, host)
      }
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree ?? EMPTY)) {
    for (const tab of tabs) {
      visits++
      if (tab.contentType === 'terminal' && tab.executionHostId) {
        merge(hosts, aliasKey(tab.worktreeId, tab.entityId), tab.executionHostId)
        merge(tabsById, tab.entityId, tab.executionHostId)
      }
    }
  }
  for (const [worktree, tabs] of Object.entries(state.tabsByWorktree ?? EMPTY)) {
    for (const tab of tabs) {
      visits++
      const host = ptyHost(tab.ptyId)
      if (host !== undefined) {
        merge(hosts, aliasKey(worktree, tab.id), host)
        merge(tabsById, tab.id, host)
      }
    }
  }
  terminalCache = { inputs, hosts, ptys, tabs: tabsById }
  return terminalCache
}
