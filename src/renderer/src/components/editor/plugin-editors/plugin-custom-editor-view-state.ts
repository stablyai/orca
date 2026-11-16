import {
  CUSTOM_EDITOR_VIEW_STATE_MAX_BYTES,
  CUSTOM_EDITOR_VIEW_STATE_RATE_LIMIT,
  isCustomEditorViewStatePost
} from '../../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { FRAME_EVENTS } from '../../../../../shared/plugins/frames/plugin-frame-bridge'
import {
  pluginEvent,
  readPluginEnvelope,
  type PluginEnvelope
} from '../../../../../shared/plugins/frames/plugin-protocol'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes
} from '../../../../../shared/plugins/frames/plugin-panel-message-budget'
import type { CustomEditorHostOptions } from './plugin-custom-editor-host-types'

/** A custom editor's view (scroll, zoom) on its own lane, so it may post every frame of a pan. */
export function createCustomEditorViewStateLane(
  options: Pick<CustomEditorHostOptions, 'getViewState' | 'onViewState'>,
  now: () => number
): {
  /** True when `data` was a view post, handled or refused. */
  claim: (data: unknown) => boolean
  /** Hands a new frame the view its tab kept; call before the first document. */
  replay: (post: (message: PluginEnvelope) => void) => void
} {
  const budget = createPanelMessageBudget({
    maxBytes: CUSTOM_EDITOR_VIEW_STATE_MAX_BYTES,
    ...CUSTOM_EDITOR_VIEW_STATE_RATE_LIMIT
  })
  return {
    claim(data) {
      if (!isCustomEditorViewStatePost(data)) {
        return false
      }
      const refused = budget.admit(
        now(),
        structuredCloneMessageBytes(data, CUSTOM_EDITOR_VIEW_STATE_MAX_BYTES)
      )
      const message = refused ? null : readPluginEnvelope(data)
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
