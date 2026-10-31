import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { StateCreator } from 'zustand'
import type { AppState } from './types'
import { discoverWorkspacePresentations } from './slices/worktrees/session/worktree-spelling-merge'
import { createWorkspaceCompositionView } from './workspace-composition-view'
import { applyViewWrite } from './workspace-presentation-write'
import {
  workspaceSourceSession,
  noteWorkspacePresentationChanges,
  workspaceSourceWrite,
  sourceWrites
} from './workspace-source-state'
import { isWorkspacePresentationKey, sourceBaseline } from '../../../shared/workspace-presentation'
import { reconcileWorkspacePresentation } from '../../../shared/workspace-presentation-reconcile'
export * from './workspace-source-state'
export {
  workspaceSourceClaims,
  failedWorkspaceTabCloseRestore
} from './workspace-presentation-close'

function settleSources(state: AppState, keys?: ReadonlySet<string>): AppState {
  let documents = state.workspacePresentations
  const changedKeys: string[] = []
  const session = workspaceSourceSession(state)
  for (const [key, saved] of keys
    ? [...keys].map(
        (key) => [key, isWorkspacePresentationKey(key) ? documents?.[key] : undefined] as const
      )
    : Object.entries(documents ?? {})) {
    if (!saved) {
      continue
    }
    const next = reconcileWorkspacePresentation(
      saved,
      saved.baseline.map(({ source }) => sourceBaseline(session, source))
    )
    if (next !== saved) {
      documents = editWorkspacePresentationDocuments(documents, key, next)
      changedKeys.push(key)
    }
  }
  if (documents && changedKeys.length) {
    noteWorkspacePresentationChanges(documents, changedKeys)
  }
  return documents === state.workspacePresentations
    ? state
    : { ...state, workspacePresentations: documents }
}

/** One lazy indexed read facade over raw state. Enumerating a record pays only at that reader. */
export function withWorkspaceComposition(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    const { project, indexDocuments, documentKey, acknowledgeSettlement } =
      createWorkspaceCompositionView()
    const wrap = (write: typeof set): typeof set => {
      function wrapped(
        partial: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>),
        replace?: false
      ): void
      function wrapped(partial: AppState | ((state: AppState) => AppState), replace: true): void
      function wrapped(
        partial: AppState | Partial<AppState> | ((state: AppState) => AppState | Partial<AppState>),
        replace?: boolean
      ): void {
        write((raw) => {
          const view = project(raw)
          const patch = typeof partial === 'function' ? partial(view) : partial
          if (patch === view || patch === raw) {
            return raw
          }
          const scope = sourceWrites.get(patch)
          let next = replace || scope ? { ...raw, ...patch } : applyViewWrite(raw, view, patch)
          if (scope?.sources?.length) {
            next = { ...next, ...discoverWorkspacePresentations(next, scope.sources) }
          }
          indexDocuments(next.workspacePresentations, scope?.documents)
          // Discovery already reconciled the changed presentation, without a source mutation.
          const hasSourceChange = [
            'unifiedTabsByWorktree',
            'groupsByWorktree',
            'layoutByWorktree',
            'activeGroupIdByWorktree'
          ].some((key) => Object.hasOwn(patch, key))
          if ((!hasSourceChange || !scope) && !replace) {
            return scope ? workspaceSourceWrite(next, scope) : next
          }
          const keys = scope?.sources
            ? new Set(
                scope.sources.flatMap((id) => {
                  const key = documentKey(id)
                  return key ? [key] : []
                })
              )
            : undefined
          const settled = settleSources(next, keys)
          // Source settlement updates baselines, never the source-to-identity association.
          acknowledgeSettlement(settled.workspacePresentations)
          return scope ? workspaceSourceWrite(settled, scope) : settled
        })
      }
      return wrapped
    }
    const originalGet = api.getState
    const originalInitial = api.getInitialState
    const originalSubscribe = api.subscribe
    api.getState = () => project(originalGet())
    api.getInitialState = () => project(originalInitial())
    api.subscribe = (listener) =>
      originalSubscribe((state, previous) => listener(project(state), project(previous)))
    api.setState = wrap(api.setState)
    return { ...createState(wrap(set), () => project(get()), api), workspacePresentations: {} }
  }
}
