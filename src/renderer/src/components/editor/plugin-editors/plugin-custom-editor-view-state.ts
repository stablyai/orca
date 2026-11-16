import {
  CUSTOM_EDITOR_VIEW_STATE_MAX_BYTES,
  isCustomEditorViewStatePost
} from '../../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { FRAME_EVENTS } from '../../../../../shared/plugins/frames/plugin-frame-bridge'
import {
  pluginEvent,
  readPluginEnvelope,
  type PluginEnvelope
} from '../../../../../shared/plugins/frames/plugin-protocol'
import { structuredCloneMessageBytes } from '../../../../../shared/plugins/frames/plugin-panel-message-budget'
import type { CustomEditorHostOptions } from './plugin-custom-editor-host-types'

/** A custom editor's view (scroll, zoom) on its own lane, so it may post every frame of a pan. */
export function createCustomEditorViewStateLane(
  options: Pick<CustomEditorHostOptions, 'getViewState' | 'onViewState'>
): {
  /** True when `data` was a view post, kept or refused for its size. */
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
      // reopen the tab at an earlier view.
      if (
        structuredCloneMessageBytes(data, CUSTOM_EDITOR_VIEW_STATE_MAX_BYTES) >
        CUSTOM_EDITOR_VIEW_STATE_MAX_BYTES
      ) {
        return true
      }
      const message = readPluginEnvelope(data)
      if (message?.kind === 'evt') {
        options.onViewState?.(message.payload ?? null)
      }
      return true
    },
    replay(post) {
      const viewState = options.getViewState?.() ?? null
      if (viewState !== null) {
        post(pluginEvent(FRAME_EVENTS.editorViewState, viewState))
      }
    }
  }
}
