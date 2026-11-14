export type BrowserHomePageDraftState = {
  persisted: string
  value: string
}

export function createBrowserHomePageDraftState(persisted: string): BrowserHomePageDraftState {
  return {
    persisted,
    value: persisted
  }
}

export function resolveBrowserHomePageDraftState(
  state: BrowserHomePageDraftState,
  persisted: string
): BrowserHomePageDraftState {
  return state.persisted === persisted ? state : createBrowserHomePageDraftState(persisted)
}
