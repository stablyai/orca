import { readCustomEditorKeyChord } from '../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { FRAME_EVENTS } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginEvent } from '../../../../shared/plugins/frames/plugin-protocol'
import type { PluginFrameMessageContext } from '../right-sidebar/plugin-frame-host'
import type { CustomEditorHostOptions } from './plugin-custom-editor-host-types'

/** A custom editor frame's own events. True when it announced that its session merges outside
 *  changes, which the host remembers for the frame's life. */
export function handleCustomEditorFrameEvent(
  event: PluginEvent,
  context: PluginFrameMessageContext,
  options: Pick<CustomEditorHostOptions, 'onFrameProgress' | 'onKeyChord' | 'onMergesOutside'>
): boolean {
  if (event.event === FRAME_EVENTS.editorMerges) {
    options.onMergesOutside?.()
    return true
  }
  if (event.event === FRAME_EVENTS.editorSubscribed) {
    options.onFrameProgress?.('subscribed')
    return false
  }
  const chord =
    event.event === FRAME_EVENTS.editorKeydown ? readCustomEditorKeyChord(event.payload) : null
  if (chord) {
    options.onKeyChord?.(chord, context)
  }
  return false
}
