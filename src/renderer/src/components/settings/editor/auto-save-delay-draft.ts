export type AutoSaveDelayDraftState = {
  sourceDelayMs: number
  draft: string
}

export function createAutoSaveDelayDraftState(
  editorAutoSaveDelayMs: number
): AutoSaveDelayDraftState {
  return {
    sourceDelayMs: editorAutoSaveDelayMs,
    draft: String(editorAutoSaveDelayMs)
  }
}

export function resolveAutoSaveDelayDraftState(
  state: AutoSaveDelayDraftState,
  editorAutoSaveDelayMs: number
): AutoSaveDelayDraftState {
  return state.sourceDelayMs === editorAutoSaveDelayMs
    ? state
    : createAutoSaveDelayDraftState(editorAutoSaveDelayMs)
}

export function updateAutoSaveDelayDraftState(
  state: AutoSaveDelayDraftState,
  editorAutoSaveDelayMs: number,
  draft: string
): AutoSaveDelayDraftState {
  return {
    // Keep committed drafts tied to their source until asynchronous persistence reloads.
    ...resolveAutoSaveDelayDraftState(state, editorAutoSaveDelayMs),
    draft
  }
}
