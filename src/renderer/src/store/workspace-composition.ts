import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { StateCreator } from 'zustand'
import type { AppState } from './types'
import { discoverWorkspacePresentations } from './slices/worktrees/session/worktree-spelling-merge'
import { createWorkspaceCompositionView } from './workspace-composition-view'
import {
  workspaceSourceSession,
  noteWorkspacePresentationChanges,
  workspaceSourceWrite,
  sourceWrites,
  readViews,
  bindingIndexes
} from './workspace-source-state'
import { isWorkspacePresentationKey, sourceBaseline } from '../../../shared/workspace-presentation'
import { settleWorkspacePresentation } from '../../../shared/workspace-presentation-settlement'
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
    const next = settleWorkspacePresentation(
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
    const { project, indexDocuments, documentKey, acknowledgeSettlement, presentationIndex } =
      createWorkspaceCompositionView()
    const bind = (raw: AppState): AppState => {
      indexDocuments(raw.workspacePresentations)
      readViews.set(raw, project)
      bindingIndexes.set(raw, presentationIndex())
      return raw
    }
    const wrap = (write: typeof set): typeof set => {
      const settleWrite = (
        raw: AppState,
        patch: Partial<AppState>,
        replacement?: AppState
      ): AppState => {
        if (patch === raw) {
          return raw
        }
        let next = replacement ?? { ...raw, ...patch }
        const scope = sourceWrites.get(patch)
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
        if (!hasSourceChange && !replacement) {
          return scope ? workspaceSourceWrite(next, scope) : next
        }
        const changed =
          scope?.sources ??
          [
            ...new Set([
              ...Object.keys(raw.unifiedTabsByWorktree),
              ...Object.keys(next.unifiedTabsByWorktree),
              ...Object.keys(raw.groupsByWorktree),
              ...Object.keys(next.groupsByWorktree)
            ])
          ].filter(
            (id) =>
              raw.unifiedTabsByWorktree[id] !== next.unifiedTabsByWorktree[id] ||
              raw.groupsByWorktree[id] !== next.groupsByWorktree[id] ||
              raw.layoutByWorktree[id] !== next.layoutByWorktree[id] ||
              raw.activeGroupIdByWorktree[id] !== next.activeGroupIdByWorktree[id]
          )
        const keys = new Set(
          changed.flatMap((id) => {
            const key = documentKey(id)
            return key ? [key] : []
          })
        )
        const settled = settleSources(next, keys)
        // Source settlement updates baselines, never the source-to-identity association.
        acknowledgeSettlement(settled.workspacePresentations)
        return scope ? workspaceSourceWrite(settled, scope) : settled
      }
      function wrapped(
        ...args:
          | [
              partial:
                | AppState
                | Partial<AppState>
                | ((state: AppState) => AppState | Partial<AppState>),
              replace?: false
            ]
          | [partial: AppState | ((state: AppState) => AppState), replace: true]
      ): void {
        if (args[1]) {
          const partial = args[0]
          write((raw) => {
            const replacement = typeof partial === 'function' ? partial(bind(raw)) : partial
            return settleWrite(raw, replacement, replacement)
          }, true)
        } else {
          const partial = args[0]
          write((raw) =>
            settleWrite(raw, typeof partial === 'function' ? partial(bind(raw)) : partial)
          )
        }
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
    const rawApi = {
      ...api,
      getState: () => bind(originalGet()),
      getInitialState: originalInitial,
      subscribe: originalSubscribe,
      setState: wrap(set)
    }
    const initial = createState(wrap(set), () => bind(get()), rawApi)
    api.setState = rawApi.setState
    return { ...initial, workspacePresentations: {} }
  }
}
