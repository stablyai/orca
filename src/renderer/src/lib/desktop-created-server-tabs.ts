// Keep desktop-created simulator/browser tabs absent from paired-server frames in this desktop’s localStorage, keyed by server/workspace; published tabs follow server frames. Never serialize or send this record.

import type { Tab } from '../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { AppState } from '@/store/types'
import type { HeldDrawnTabs } from '@/store/workspace-layout-frame-held-tabs'

const STORAGE_KEY = 'orca.desktop-created-server-tabs.v1'

type Entry = { environmentId: string; worktreeId: string; ids: Set<string> }

/** By `environmentId\0worktreeId`; loaded on first use. */
let records: Map<string, Entry> | undefined

function recordMap(): Map<string, Entry> {
  // Only layout-owner builds consume these server-frame exceptions.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return new Map()
  }
  if (records) {
    return records
  }
  records = new Map()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    for (const entry of Array.isArray(saved) ? saved : []) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string' &&
        Array.isArray(entry[2])
      ) {
        const ids = entry[2].filter((id: unknown): id is string => typeof id === 'string')
        records.set(`${entry[0]}\0${entry[1]}`, {
          environmentId: entry[0],
          worktreeId: entry[1],
          ids: new Set(ids)
        })
      }
    }
  } catch {
    // Storage may be unavailable: the record then lasts until reload.
  }
  return records
}

function save(map: Map<string, Entry>): void {
  for (const [key, entry] of map) {
    if (entry.ids.size === 0) {
      map.delete(key)
    }
  }
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return
  }
  try {
    const entries = [...map.values()].map((e) => [e.environmentId, e.worktreeId, [...e.ids]])
    if (entries.length === 0) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
    }
  } catch {}
}

const entriesOf = (workspace: string): Entry[] =>
  [...recordMap().values()].filter((entry) => entry.worktreeId === workspace)

export function noteDesktopCreatedServerTab(
  environmentId: string,
  workspace: string,
  id: string
): void {
  const map = recordMap()
  const key = `${environmentId}\0${workspace}`
  const entry = map.get(key) ?? { environmentId, worktreeId: workspace, ids: new Set<string>() }
  if (map.get(key) === entry && entry.ids.has(id)) {
    return
  }
  map.set(key, entry)
  entry.ids.add(id)
  save(map)
}

function forgetIn(entries: readonly Entry[], ids: Iterable<string>): void {
  let changed = false
  for (const id of ids) {
    for (const entry of entries) {
      changed = entry.ids.delete(id) || changed
    }
  }
  if (changed) {
    save(recordMap())
  }
}

export function forgetDesktopCreatedServerTab(id: string): void {
  forgetIn([...recordMap().values()], [id])
}

export function forgetDesktopCreatedServerTabsOf(workspace: string): void {
  const entries = entriesOf(workspace)
  forgetIn(
    entries,
    entries.flatMap((entry) => [...entry.ids])
  )
}

/** The server's frame now lists these ids: from here on its frames draw them. */
export function forgetPublishedServerTabs(workspace: string, ids: Iterable<string>): void {
  const entries = entriesOf(workspace)
  if (entries.length > 0) {
    forgetIn(entries, ids)
  }
}

/** After a restore, before any frame: an id whose tab the session did not restore is gone. */
export function pruneDesktopCreatedServerTabs(
  state: Pick<AppState, 'unifiedTabsByWorktree'>
): void {
  const map = recordMap()
  for (const entry of map.values()) {
    const rows = new Set(
      (state.unifiedTabsByWorktree[entry.worktreeId] ?? []).flatMap((tab) => [tab.id, tab.entityId])
    )
    forgetIn(
      [entry],
      [...entry.ids].filter((id) => !rows.has(id))
    )
  }
}

const isCreated = (workspace: string, id: string): boolean =>
  entriesOf(workspace).some((entry) => entry.ids.has(id))

export function desktopCreatedServerTabEnvironments(workspace: string, id: string): string[] {
  return entriesOf(workspace).flatMap((entry) => (entry.ids.has(id) ? [entry.environmentId] : []))
}

export function isDesktopCreatedServerTab(
  tabs: readonly Pick<Tab, 'id' | 'entityId'>[] | undefined,
  workspace: string,
  tabId: string
): boolean {
  const entityId = tabs?.find((tab) => tab.id === tabId)?.entityId
  return isCreated(workspace, tabId) || (entityId !== undefined && isCreated(workspace, entityId))
}

export const DESKTOP_CREATED_SERVER_TAB_HOLDS: HeldDrawnTabs = {
  isTabHeld: isCreated,
  isGroupLayoutHeld: () => false,
  keepsInMainGroups: isCreated
}

export function _reloadDesktopCreatedServerTabsForTests(): void {
  records = undefined
}

export function _resetDesktopCreatedServerTabsForTests(): void {
  records = new Map()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {}
}
