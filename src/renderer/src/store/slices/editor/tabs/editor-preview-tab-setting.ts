import type { AppState } from '../../../types'

export type EditorPreviewSettingState = Pick<AppState, 'settings'>

/** Preview is enabled unless the user turned it off; older profiles have no key.
 *  Readers derive preview-ness from this plus the stored flag — the flag is never
 *  rewritten when the setting changes, so sessions, host switches and other windows
 *  can't leave a tab behaving like a preview after previews are off. */
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
