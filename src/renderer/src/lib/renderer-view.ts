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
