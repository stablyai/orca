import type { TopLevelView } from '../../../shared/ui-chrome-types'

export type RendererView = TopLevelView | 'thread-draft' | 'empty-workbench'

/** Pre-session pages are window-local; host persistence keeps its existing vocabulary. */
export function workspaceView(view: RendererView): TopLevelView {
  return view === 'thread-draft' || view === 'empty-workbench' ? 'terminal' : view
}

/** Disabling the experiment presents its retained local route as the ordinary workspace. */
export function effectiveWorkspaceView(state: {
  activeView: RendererView
  settings?: { experimentalThreads?: boolean } | null
}): RendererView {
  return state.settings?.experimentalThreads ? state.activeView : workspaceView(state.activeView)
}

/** Sections remember a workspace destination without owning its live selection. */
export function desktopWorkspaceContextView(state: {
  activeView: RendererView
  previousViewBeforeSettings?: RendererView
  previousViewBeforeTasks?: RendererView
  settings?: { experimentalThreads?: boolean } | null
}): RendererView {
  let view = state.activeView
  if (view === 'settings') {
    view = state.previousViewBeforeSettings ?? 'terminal'
  }
  if (view === 'tasks') {
    view = state.previousViewBeforeTasks ?? 'terminal'
  }
  return effectiveWorkspaceView({ activeView: view, settings: state.settings })
}
