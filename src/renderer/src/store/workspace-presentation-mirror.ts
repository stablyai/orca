import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import {
  isWorkspacePresentationKey,
  type WorkspacePresentationDelta
} from '../../../shared/workspace-presentation'
import type { AppState } from './types'
import { noteWorkspacePresentationChanges, workspaceSourceWrite } from './workspace-source-state'
import { recordWorkspacePresentationIntent } from '../../../shared/workspace-presentation-user-intent'

type Delta = WorkspacePresentationDelta
/** Buffer owner publications while startup hydrates sources; a late checkpoint cannot reset U. */
export function workspacePresentationMirror(
  store: { getState: () => AppState; setState: (patch: Partial<AppState>) => void },
  subscribe: ((listener: (delta: Delta) => void) => () => void) | undefined
) {
  let active = false
  let pending: Delta[] = []
  const apply = ({ changed, removed, intent }: Delta): void => {
    let documents = store.getState().workspacePresentations ?? {}
    const keys = [...Object.keys(changed), ...removed]
    for (const key of keys) {
      if (isWorkspacePresentationKey(key)) {
        const before = documents[key],
          after = changed[key]
        if (before && after && intent?.[key]) {
          recordWorkspacePresentationIntent(before, intent[key], after)
        }
        documents = editWorkspacePresentationDocuments(documents, key, changed[key])
      }
    }
    noteWorkspacePresentationChanges(documents, keys)
    store.setState(workspaceSourceWrite({ workspacePresentations: documents }, { documents: keys }))
  }
  const unsubscribe = subscribe?.((delta) => {
    if (active) {
      apply(delta)
    } else {
      pending.push(delta)
    }
  })

  return {
    activate: () => {
      active = true
      for (const delta of pending) {
        apply(delta)
      }
      pending = []
    },
    close: () => {
      unsubscribe?.()
      pending = []
    }
  }
}
