import type { AppState } from '../../../types'

export type EditorPreviewSettingState = Pick<AppState, 'settings'>

/** Preview flag is intent; combine with current setting at every reader. Settings changes do not rewrite stored flags, including across hosts/windows/restore; older profiles default enabled. */
export function areEditorPreviewTabsEnabled(state: EditorPreviewSettingState): boolean {
  return state.settings?.editorPreviewTabsEnabled !== false
}

/** A caller's preview request is an intent; the setting is the authority. */
export function resolveEditorPreviewIntent(
  state: EditorPreviewSettingState,
  requestedPreview: boolean | undefined
): boolean {
  return (requestedPreview ?? false) && areEditorPreviewTabsEnabled(state)
}
