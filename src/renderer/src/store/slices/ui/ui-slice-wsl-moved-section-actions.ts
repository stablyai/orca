import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import {
  wslMovedProjectKey,
  type WslMovedProject
} from '../../../../../shared/wsl-move/wsl-moved-project'
import type { UISlice, UISliceSet } from './ui-slice-contract'

// Bounds a profile that never reaches a successful moved-project read.
const MAX_HIDDEN_WSL_MOVED_PROJECT_KEYS = 500

export function hydrateWslMovedSection(
  ui: PersistedUIState
): Pick<UISlice, 'wslMovedSectionCollapsed' | 'hiddenWslMovedProjectKeys'> {
  const keys = Array.isArray(ui.hiddenWslMovedProjectKeys) ? ui.hiddenWslMovedProjectKeys : []
  return {
    wslMovedSectionCollapsed: ui.wslMovedSectionCollapsed === true,
    hiddenWslMovedProjectKeys: [
      ...new Set(keys.filter((key): key is string => typeof key === 'string'))
    ].slice(-MAX_HIDDEN_WSL_MOVED_PROJECT_KEYS)
  }
}

/** The hidden keys still naming a moved project; the same array when nothing was dropped. */
export function retainHiddenWslMovedProjectKeys(
  hidden: readonly string[],
  projects: readonly WslMovedProject[]
): readonly string[] {
  const moved = new Set(projects.map(wslMovedProjectKey))
  const kept = hidden.filter((key) => moved.has(key))
  return kept.length === hidden.length ? hidden : kept
}

export function createUiWslMovedSectionActions(set: UISliceSet): Partial<UISlice> {
  return {
    wslMovedSectionCollapsed: false,
    setWslMovedSectionCollapsed: (collapsed) =>
      set((s) => {
        if (s.wslMovedSectionCollapsed === collapsed) {
          return s
        }
        window.api.ui.set({ wslMovedSectionCollapsed: collapsed }).catch(console.error)
        return { wslMovedSectionCollapsed: collapsed }
      }),
    hiddenWslMovedProjectKeys: [],
    hideWslMovedProject: (project) =>
      set((s) => {
        const key = wslMovedProjectKey(project)
        if (s.hiddenWslMovedProjectKeys.includes(key)) {
          return s
        }
        const next = [...s.hiddenWslMovedProjectKeys, key].slice(-MAX_HIDDEN_WSL_MOVED_PROJECT_KEYS)
        window.api.ui.set({ hiddenWslMovedProjectKeys: next }).catch(console.error)
        return { hiddenWslMovedProjectKeys: next }
      }),
    retainHiddenWslMovedProjects: (projects) =>
      set((s) => {
        const next = retainHiddenWslMovedProjectKeys(s.hiddenWslMovedProjectKeys, projects)
        if (next === s.hiddenWslMovedProjectKeys) {
          return s
        }
        const kept = [...next]
        window.api.ui.set({ hiddenWslMovedProjectKeys: kept }).catch(console.error)
        return { hiddenWslMovedProjectKeys: kept }
      })
  }
}
