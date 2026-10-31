import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import { isWorkspacePresentationKey } from '../../../shared/workspace-presentation'
import { reduceWorkspacePresentation } from '../../../shared/workspace-presentation-intent'
import type { TabsSliceSet } from './slices/tabs/tabs-slice-contract'
import type { AppState } from './types'
import { noteWorkspacePresentationSelection } from '../../../shared/workspace-presentation-user-intent'
import {
  noteWorkspacePresentationChanges,
  workspaceReadState,
  bindingIndexes
} from './workspace-source-state'
import { workspacePresentationFor } from './workspace-source-state'

export function acceptWorkspacePresentationSelection(
  state: AppState,
  workspaceId: string,
  groupId: string
): void {
  const saved = workspacePresentationFor(state, workspaceId)
  if (saved) {
    noteWorkspacePresentationSelection(saved, groupId)
  }
}

const layoutKeys = [
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree'
] as const

/** An explicit U reducer adapter for tab-placement actions, never the default source setter. */
export function presentationActionSet(set: TabsSliceSet): TabsSliceSet {
  const write: TabsSliceSet = (partial) =>
    set((raw) => {
      const view = workspaceReadState(raw)
      const patch = typeof partial === 'function' ? partial(view) : partial
      if (patch === view || patch === raw) {
        return raw
      }
      const after = { ...view, ...patch }
      let documents = raw.workspacePresentations ?? {}
      const changed: string[] = []
      const index = bindingIndexes.get(raw)
      for (const field of layoutKeys) {
        if (!Object.hasOwn(patch, field)) {
          continue
        }
        for (const id of Object.keys(after[field])) {
          const key = index?.get(id)
          const saved = key && isWorkspacePresentationKey(key) ? documents[key] : undefined
          if (saved && id !== saved.displayWorkspaceId && after[field][id] !== view[field][id]) {
            Object.assign(after, {
              [field]: { ...after[field], [saved.displayWorkspaceId]: after[field][id] }
            })
          }
        }
      }
      const affected = new Set(
        layoutKeys.flatMap((field) =>
          Object.hasOwn(patch, field)
            ? [...new Set([...Object.keys(view[field]), ...Object.keys(after[field])])].flatMap(
                (id) => {
                  const key = index?.get(id)
                  return key && after[field][id] !== view[field][id] ? [key] : []
                }
              )
            : []
        )
      )
      for (const key of affected) {
        if (!isWorkspacePresentationKey(key)) {
          continue
        }
        const saved = documents[key]
        if (!saved) {
          continue
        }
        const id = saved.displayWorkspaceId
        if (!layoutKeys.some((field) => after[field][id] !== view[field][id])) {
          continue
        }
        documents = editWorkspacePresentationDocuments(
          documents,
          key,
          reduceWorkspacePresentation(saved, {
            type: 'layout',
            tabs: after.unifiedTabsByWorktree[id] ?? [],
            groups: after.groupsByWorktree[id] ?? [],
            layout: after.layoutByWorktree[id],
            activeGroupId: after.activeGroupIdByWorktree[id]
          })
        )
        changed.push(key)
      }
      const result: Partial<AppState> = { ...patch }
      // Only unbound workspaces still use the legacy source-local placement reducer.
      for (const field of layoutKeys) {
        if (!Object.hasOwn(patch, field)) {
          continue
        }
        Object.assign(result, {
          [field]: Object.fromEntries(
            [...new Set([...Object.keys(raw[field]), ...Object.keys(after[field])])].flatMap(
              (id) => {
                const bound = index?.get(id)
                const value = bound ? raw[field][id] : after[field][id]
                return value === undefined ? [] : [[id, value]]
              }
            )
          )
        })
      }
      if (changed.length) {
        noteWorkspacePresentationChanges(documents, changed)
        result.workspacePresentations = documents
      }
      return result
    })
  return write
}
