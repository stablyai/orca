import type { CustomEditorKeyChord } from '../../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import type { PluginFrameEditorChannel } from '../../plugins/frames/plugin-frame-host'
import type {
  PluginFrameMessageContext,
  PluginFrameWindow
} from '../../plugins/frames/plugin-frame-host-lanes'
import type { PanelMessageBudget } from '../../../../../shared/plugins/frames/plugin-panel-message-budget'

export type CustomEditorEditRefusal = 'oversized' | 'rate_limited'

/** Why an edit has not reached the buffer: held for the rate limit, or lost for size. */
export type CustomEditorUnappliedEdit = 'held' | 'lost' | null

/** A binary editor's document; a new object means new bytes to send. */
export type CustomEditorBinaryDocument = { bytes: Uint8Array<ArrayBuffer>; fileType: string }

export type CustomEditorHostOptions = {
  getFrameWindow: () => PluginFrameWindow | null
  /** The buffer as Orca holds it now. */
  getDocument: () => { text: string; readOnly: boolean }
  /** Binary editors only: the document's bytes, or null while they load. */
  getBinaryDocument?: () => CustomEditorBinaryDocument | null
  onEdit: (text: string) => void
  /** Binary editors: the frame's full replacement; the host then treats it as what the frame holds. */
  onBytesEdit?: (document: CustomEditorBinaryDocument) => void
  onEditRefused?: (reason: CustomEditorEditRefusal) => void
  /** The frame holds edits the buffer lacks, or caught up again. */
  onUnappliedEdit?: (state: CustomEditorUnappliedEdit) => void
  /** `context.userActivation`: the chord rode real input in the frame. */
  onKeyChord?: (chord: CustomEditorKeyChord, context: PluginFrameMessageContext) => void
  /** The frame got a document, or asked for one; `orca plugin shot --editor` waits on both. */
  onFrameProgress?: (step: 'delivered' | 'subscribed') => void
  /** The frame's document session merges outside changes; set once per frame. */
  onMergesOutside?: () => void
  /** The edit lane; every other message spends the frame's shared budget. */
  budget?: PanelMessageBudget
  now?: () => number
  flushTimeoutMs?: number
}

export type CustomEditorHost = {
  /** Plugged into the frame host for this editor's frame. */
  channel: PluginFrameEditorChannel
  /** Push the buffer when it changed outside the frame (reload, revert, Source edits). */
  syncDocument: () => void
  /** Waits for edits still in the frame's debounce window; false on timeout or when an edit
   *  never reached the buffer, so a save must not mark the tab clean. */
  flush: () => Promise<boolean>
  /** The newest text either side holds: the frame's last edit or the buffer last sent. */
  currentText: () => string
  /** A new document mounted in the frame; it must announce ready again. */
  reset: () => void
  /** Sends a disk change to a frame whose session merges it into the unsaved edits, and resolves
   *  with the merged text once the session's merged edit is in the buffer; null when the frame
   *  cannot or does not within the flush deadline, so the caller keeps the banner. */
  mergeOutsideChange: (diskText: string, ancestorText: string) => Promise<string | null>
}
