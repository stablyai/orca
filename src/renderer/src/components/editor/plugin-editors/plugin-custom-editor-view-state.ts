import {
  CUSTOM_EDITOR_VIEW_STATE_MAX_CHARS,
  isCustomEditorViewStatePost
} from '../../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { FRAME_EVENTS } from '../../../../../shared/plugins/frames/plugin-frame-bridge'
import { isPluginJsonObject } from '../../../../../shared/plugins/manifest/plugin-json-object'
import {
  pluginEvent,
  readPluginEnvelope,
  type PluginEnvelope
} from '../../../../../shared/plugins/frames/plugin-protocol'
import type { CustomEditorHostOptions } from './plugin-custom-editor-host-types'

/** A custom editor's view (scroll, zoom) on its own lane, so it may post every frame of a pan. */
export function createCustomEditorViewStateLane(
  options: Pick<CustomEditorHostOptions, 'getViewState' | 'onViewState'>
): {
  /** True when `data` was a view post, kept or refused. */
  claim: (data: unknown) => boolean
  /** Hands a new frame the view its tab kept; call before the first document. */
  replay: (post: (message: PluginEnvelope) => void) => void
} {
  return {
    claim(data) {
      if (!isCustomEditorViewStatePost(data)) {
        return false
      }
      // Why no rate limit: a post only replaces this tab's entry, and dropping the last one would
      // reopen the tab at an earlier view. The length rule is the shell's own, checked first.
      const json = isPluginJsonObject(data) ? data.payload : undefined
      const valid =
        json === null ||
        (typeof json === 'string' && json.length <= CUSTOM_EDITOR_VIEW_STATE_MAX_CHARS)
      if (valid && readPluginEnvelope(data)) {
        options.onViewState?.(json)
      }
      return true
    },
    replay(post) {
      const json = options.getViewState?.() ?? null
      if (json !== null) {
        post(pluginEvent(FRAME_EVENTS.editorViewState, json))
      }
    }
  }
}
