import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { TopLevelView } from '../../../shared/ui-chrome-types'

type ActiveViewUnloadState = {
  activeView: TopLevelView
  persistedUIReady: boolean
}

export function buildActiveViewUnloadPatch(
  state: ActiveViewUnloadState
): Partial<PersistedUIState> {
  // Why: unloading during startup must not overwrite the saved view with the
  // renderer default before persisted UI hydration finishes.
  return state.persistedUIReady ? { activeView: state.activeView } : {}
}
