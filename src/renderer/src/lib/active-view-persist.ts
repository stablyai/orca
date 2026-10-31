import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import { workspaceView, type RendererView } from './renderer-view'

type ActiveViewUnloadState = {
  activeView: RendererView
  persistedUIReady: boolean
}

export function buildActiveViewUnloadPatch(
  state: ActiveViewUnloadState
): Partial<PersistedUIState> {
  // Startup unload must not replace the saved view with defaults before hydration.
  return state.persistedUIReady ? { activeView: workspaceView(state.activeView) } : {}
}
