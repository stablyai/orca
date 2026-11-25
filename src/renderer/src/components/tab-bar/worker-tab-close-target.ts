import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { workerTabStampsEqual } from '../../../../shared/orchestration/workers/worker-tab-stamp'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { workerTabCloseKind, type WorkerTabCloseKind } from './worker-tab-view-actions'
import { stampedLegacyCloseAddresses } from './stamped-legacy-close-addresses'

// Store-safe: no store import, so the store's bulk close can use it synchronously.

/** A close address resolved against this window: a tab, or a known worker it cannot pin down. */
export type WorkerCloseTarget =
  | { kind: 'tab'; tab: Tab; worktreeId: string }
  | { kind: 'protected' }
  | null

type CloseAddressState = Pick<AppState, 'unifiedTabsByWorktree' | 'tabsByWorktree'>
type CloseKindState = Pick<AppState, 'terminalLayoutsByTabId'>
type AddressIndex = ReadonlyMap<string, readonly { tab: Tab; worktreeId: string }[]>
const addressIndexes = new WeakMap<AppState['unifiedTabsByWorktree'], AddressIndex>()

/** One pass over the unified rows, reused until they change: a tab is addressed by its id, a terminal
 *  also by its entity id. */
function indexCloseAddresses(state: Pick<AppState, 'unifiedTabsByWorktree'>): AddressIndex {
  const cached = addressIndexes.get(state.unifiedTabsByWorktree)
  if (cached) {
    return cached
  }
  const index = new Map<string, { tab: Tab; worktreeId: string }[]>()
  const add = (address: string, entry: { tab: Tab; worktreeId: string }): void => {
    const list = index.get(address)
    if (!list) {
      index.set(address, [entry])
    } else if (!list.some((known) => known.tab === entry.tab)) {
      list.push(entry)
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      add(tab.id, { tab, worktreeId })
      if (tab.contentType === 'terminal') {
        add(tab.entityId, { tab, worktreeId })
      }
    }
  }
  addressIndexes.set(state.unifiedTabsByWorktree, index)
  return index
}

/** An exact unified match can still disagree with the legacy terminal the close would reach. */
export function workerCloseTargetForTab(
  state: Pick<AppState, 'tabsByWorktree'>,
  tab: Tab,
  worktreeId: string
): WorkerCloseTarget {
  const legacy = stampedLegacyCloseAddresses(state.tabsByWorktree)
  const conflicts = (address: string): boolean => {
    const owners = legacy.get(address)
    const stamp = owners?.get(worktreeId)
    return (
      owners !== undefined &&
      (owners.size !== 1 ||
        !stamp ||
        tab.contentType !== 'terminal' ||
        tab.entityId !== address ||
        !workerTabStampsEqual(tab.workerTab, stamp))
    )
  }
  if (
    conflicts(tab.id) ||
    (tab.contentType === 'terminal' && tab.entityId !== tab.id && conflicts(tab.entityId))
  ) {
    return { kind: 'protected' }
  }
  return { kind: 'tab', tab, worktreeId }
}

/** Resolve a close address; an ambiguous or legacy-only stamped address stays protected. */
export function resolveWorkerCloseTarget(
  state: CloseAddressState,
  id: string,
  index: AddressIndex = indexCloseAddresses(state)
): WorkerCloseTarget {
  const matches = index.get(id) ?? []
  if (matches.length === 1) {
    const { tab, worktreeId } = matches[0]!
    return workerCloseTargetForTab(state, tab, worktreeId)
  }
  const stamped =
    matches.some((match) => match.tab.workerTab) ||
    stampedLegacyCloseAddresses(state.tabsByWorktree).has(id)
  return stamped ? { kind: 'protected' } : null
}

/** What a close gesture should do with an address: 'none' closes as usual. */
export function workerCloseKindOf(
  state: CloseKindState,
  target: WorkerCloseTarget
): WorkerTabCloseKind {
  if (!target) {
    return 'none'
  }
  return target.kind === 'protected' ? 'mixed' : workerTabCloseKind(state, target.tab)
}

export function notifyMixedWorkerTabKept(key: string): void {
  // One id per tab: repeated Cmd/Ctrl+W refreshes the same note instead of stacking more.
  toast(
    translate('workerTabs.closeKept.tab', 'This tab has a worker · close your terminal pane first'),
    { id: `worker-tab-kept:${key}` }
  )
}

/** The addresses a bulk close keeps, counted once when it chose them, with one note. */
export function admitBulkWorkerClose(
  state: CloseAddressState & CloseKindState,
  tabIds: readonly string[]
): Set<string> {
  const index = indexCloseAddresses(state)
  const kept = new Set<string>()
  const keptTabs = new Set<string>()
  for (const id of tabIds) {
    const target = resolveWorkerCloseTarget(state, id, index)
    if (workerCloseKindOf(state, target) === 'mixed') {
      kept.add(id)
      keptTabs.add(target?.kind === 'tab' ? target.tab.id : `address:${id}`)
    }
  }
  if (keptTabs.size > 0) {
    toast(
      translate('workerTabs.closeKept.bulk', 'Kept {{count}} tabs with workers', {
        count: keptTabs.size,
        defaultValue_one: 'Kept {{count}} tab with a worker'
      }),
      { id: `worker-tabs-kept:${createNonSecureContextUuid()}` }
    )
  }
  return kept
}
