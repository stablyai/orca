import { useEffect } from 'react'
import {
  isPluginWorkspaceListRegistration,
  type PluginWorkspaceListRegistration
} from '../../../shared/plugins/artifacts/plugin-workspace-list-artifact'
import { isPluginContentSwitchedOff } from '../../../shared/plugins/plugin-system-settings'
import type { SidebarListArrangement } from '../../../shared/sidebar-list/arranged-groups'
import { compileListArrangement } from '../../../shared/workspace-lists/compile-list-arrangement'
import { createPluginContentListStore } from './plugin-content-list-store'
import { useAppStore } from './index'

const workspaceLists = createPluginContentListStore<PluginWorkspaceListRegistration>({
  kind: 'workspace lists',
  list: (api) => api.listWorkspaceLists,
  isEntry: isPluginWorkspaceListRegistration
})

export const usePluginWorkspaceListStore = workspaceLists.useStore
export const usePluginWorkspaceLists = workspaceLists.useEntries

const compiled = new WeakMap<PluginWorkspaceListRegistration, SidebarListArrangement | null>()

function arrangementOf(entry: PluginWorkspaceListRegistration): SidebarListArrangement | null {
  if (!compiled.has(entry)) {
    try {
      compiled.set(entry, { listId: entry.id, compiled: compileListArrangement(entry.arrangement) })
    } catch (error) {
      console.error('[workspace-list] arrangement failed; keeping Orca grouping', error)
      compiled.set(entry, null)
    }
  }
  return compiled.get(entry) ?? null
}

/** The plugin arrangement the person picked, compiled once; null keeps Orca's grouping. */
export function useSelectedListArrangement(): SidebarListArrangement | null {
  const listId = useAppStore((s) => {
    const id = s.settings?.workspaceListId
    return id && !isPluginContentSwitchedOff(s.settings ?? undefined, id) ? id : null
  })
  useEffect(() => {
    if (listId) {
      workspaceLists.ensureLoaded()
    }
  }, [listId])
  const entry = usePluginWorkspaceListStore((s) =>
    listId ? (s.entries.find((candidate) => candidate.id === listId) ?? null) : null
  )
  return entry ? arrangementOf(entry) : null
}

export function ensurePluginWorkspaceListsLoaded(): void {
  workspaceLists.ensureLoaded()
}
