import type { PersistedState } from './persisted-state-types'
import type { SshRemotePtyLease } from './ssh-types'
import { makePaneKey } from './workspace-layout/stable-pane-id'

export function moveRecordKey<T>(
  record: Record<string, T> | undefined,
  fromKey: string,
  toKey: string | null,
  remap: (value: T) => T = (value) => value,
  /** Preserve existing destination values on collision. */
  keepTarget = false
): Record<string, T> | undefined {
  if (!record || !Object.hasOwn(record, fromKey)) {
    return record
  }
  const next = { ...record }
  const value = next[fromKey]
  delete next[fromKey]
  if (toKey !== null && value !== undefined && !(keepTarget && Object.hasOwn(next, toKey))) {
    next[toKey] = remap(value)
  }
  return next
}

const PANE_KEYED_UI_RECORDS = [
  'acknowledgedAgentsByPaneKey',
  'activityClearedAtByPaneKey',
  'manuallyUnreadTurnsByPaneKey'
] as const

type PaneAddress = { tabId: string; leafId: string }

export function rekeyPaneProfileRecords(
  state: Partial<Pick<PersistedState, 'ui' | 'sshRemotePtyLeases'>>,
  from: PaneAddress,
  to: PaneAddress
): { ui?: PersistedState['ui']; sshRemotePtyLeases?: SshRemotePtyLease[] } {
  const fromPaneKey = makePaneKey(from.tabId, from.leafId)
  const toPaneKey = makePaneKey(to.tabId, to.leafId)
  const ui = state.ui
  let nextUi: PersistedState['ui'] | undefined
  for (const key of PANE_KEYED_UI_RECORDS) {
    const moved = moveRecordKey(ui?.[key], fromPaneKey, toPaneKey)
    if (ui && moved !== ui[key]) {
      nextUi = { ...(nextUi ?? ui), [key]: moved }
    }
  }
  const leases = state.sshRemotePtyLeases ?? []
  const leasesChanged = leases.some(
    (lease) => lease.tabId === from.tabId && lease.leafId === from.leafId
  )
  return {
    ...(nextUi ? { ui: nextUi } : {}),
    ...(leasesChanged
      ? {
          sshRemotePtyLeases: leases.map((lease) =>
            lease.tabId === from.tabId && lease.leafId === from.leafId
              ? { ...lease, tabId: to.tabId, leafId: to.leafId }
              : lease
          )
        }
      : {})
  }
}
