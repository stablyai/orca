import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  normalizeWorkspaceLabels,
  validateWorkspaceLabelName
} from '../../../../../shared/workspace/labels/workspace-labels'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'

export function createWorkspaceLabelActions(
  set: UISliceSet,
  get: UISliceGet
): Pick<UISlice, 'workspaceLabels' | 'addWorkspaceLabel'> {
  return {
    workspaceLabels: [],
    addWorkspaceLabel: (name, color) => {
      const existing = get().workspaceLabels
      if (validateWorkspaceLabelName(name, existing) !== null) {
        return null
      }
      const label = { id: createNonSecureContextUuid(), name: name.trim(), color }
      const normalized = normalizeWorkspaceLabels([...existing, label])
      if (normalized.length === existing.length) {
        return null
      }
      window.api.ui.set({ workspaceLabels: normalized }).catch(console.error)
      set({ workspaceLabels: normalized })
      return normalized.at(-1) ?? null
    }
  }
}
