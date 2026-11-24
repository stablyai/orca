import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { reconcileExpandedLineageGroupsOnCollapseChange } from '../../../../../shared/sidebar-list/lineage/auto-collapse-lineage-state'
import { toggleCollapsedGroupSet } from './collapsed-group-toggle'
import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'

export function hydrateUiCollapseState(
  ui: Pick<PersistedUIState, 'collapsedGroups' | 'expandedLineageGroups'>
): Pick<UISlice, 'collapsedGroups' | 'expandedLineageGroups'> {
  return {
    collapsedGroups: new Set(ui.collapsedGroups ?? []),
    expandedLineageGroups: new Set(ui.expandedLineageGroups ?? [])
  }
}

export function createUiCollapseActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    collapsedGroups: new Set<string>(),
    expandedLineageGroups: new Set<string>(),
    toggleCollapsedGroup: (key) =>
      set((s) => {
        const next = toggleCollapsedGroupSet(s.collapsedGroups, key)
        const nextExpanded = reconcileExpandedLineageGroupsOnCollapseChange({
          previousCollapsed: s.collapsedGroups,
          nextCollapsed: next,
          previousExpanded: s.expandedLineageGroups,
          trackExplicitExpands: s.settings?.startChildWorkspacesCollapsed === true
        })
        const uiPatch: Partial<PersistedUIState> = { collapsedGroups: [...next] }
        if (nextExpanded !== s.expandedLineageGroups) {
          uiPatch.expandedLineageGroups = [...nextExpanded]
        }
        window.api.ui.set(uiPatch).catch(console.error)
        return nextExpanded === s.expandedLineageGroups
          ? { collapsedGroups: next }
          : { collapsedGroups: next, expandedLineageGroups: new Set(nextExpanded) }
      }),
    setCollapsedGroups: (keys) => {
      const current = get()
      const nextExpanded = reconcileExpandedLineageGroupsOnCollapseChange({
        previousCollapsed: current.collapsedGroups,
        nextCollapsed: keys,
        previousExpanded: current.expandedLineageGroups,
        trackExplicitExpands: current.settings?.startChildWorkspacesCollapsed === true
      })
      const uiPatch: Partial<PersistedUIState> = { collapsedGroups: [...keys] }
      if (nextExpanded !== current.expandedLineageGroups) {
        uiPatch.expandedLineageGroups = [...nextExpanded]
      }
      set(
        nextExpanded === current.expandedLineageGroups
          ? { collapsedGroups: keys }
          : { collapsedGroups: keys, expandedLineageGroups: new Set(nextExpanded) }
      )
      window.api.ui.set(uiPatch).catch(console.error)
    },
    applyLineageCollapseState: (update) => {
      const uiPatch: Partial<PersistedUIState> = {}
      const statePatch: Partial<UISlice> = {}
      if (update.collapsedGroups !== undefined) {
        statePatch.collapsedGroups = update.collapsedGroups
        uiPatch.collapsedGroups = [...update.collapsedGroups]
      }
      if (update.expandedLineageGroups !== undefined) {
        statePatch.expandedLineageGroups = update.expandedLineageGroups
        uiPatch.expandedLineageGroups = [...update.expandedLineageGroups]
      }
      if (Object.keys(statePatch).length === 0) {
        return
      }
      set(statePatch)
      window.api.ui.set(uiPatch).catch(console.error)
    }
  }
}
