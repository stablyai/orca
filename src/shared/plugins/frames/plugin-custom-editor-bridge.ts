import { z } from 'zod'
import { isPluginJsonObject } from '../manifest/plugin-json-object'
import { EDITOR_METHODS } from './plugin-frame-bridge'
import { pluginError, type PluginError } from './plugin-protocol'

/**
 * The document channel of a custom editor frame, on the shared envelope. The frame only ever sees
 * the document's text, or its bytes for a binary editor: Orca keeps the buffer, dirty state, saving
 * and the file's location, so the plugin never learns a path or touches a file system.
 */

/** Why this cap: it bounds one structured-clone edit while fitting image-heavy scenes and
 *  workbooks. It applies to text and to bytes, in both directions. */
export const CUSTOM_EDITOR_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024
/** Past this the tab says the editor may take a moment to load or save. */
export const CUSTOM_EDITOR_LARGE_DOCUMENT_BYTES = 16 * 1024 * 1024
/** Edits are full-text, so a debounced editor needs only a few per second. */
export const CUSTOM_EDITOR_EDIT_RATE_LIMIT = { maxMessages: 60, perMs: 10_000 }
/** How long a save waits for the frame to post an edit still in its debounce window. */
export const CUSTOM_EDITOR_FLUSH_TIMEOUT_MS = 1_000

/** `bytes` is an ArrayBuffer, never base64; an edit replaces the whole document. */
export type CustomEditorContent =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; bytes: ArrayBuffer }

/** Payload of the `editor.document` event: `window.orca.document.get()` in the frame. */
export type CustomEditorDocument = {
  /** Rises each time Orca sends a document; an edit names the version it was made against. */
  version: number
  readOnly: boolean
  content: CustomEditorContent
  /** Bytes documents: the manifest suffix that matched, e.g. `xlsx`; never a path or file name. */
  fileType?: string
}

const customEditorEditSchema = z.strictObject({
  // Why required: an edit that names no version could silently overwrite an outside change.
  baseVersion: z.number().int().nonnegative(),
  content: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), text: z.string() }),
    z.strictObject({ kind: z.literal('bytes'), bytes: z.instanceof(ArrayBuffer) })
  ])
})

export type CustomEditorEdit = z.infer<typeof customEditorEditSchema>

export function readCustomEditorEdit(params: unknown): CustomEditorEdit | null {
  const parsed = customEditorEditSchema.safeParse(params)
  return parsed.success ? parsed.data : null
}

/** Whether a frame message claims to be an edit, read before it is admitted. */
export function isCustomEditorEditAttempt(data: unknown): boolean {
  return isPluginJsonObject(data) && data.kind === 'req' && data.method === EDITOR_METHODS.applyEdit
}

export const CUSTOM_EDITOR_CONFLICT: PluginError = pluginError(
  'conflict',
  'The file changed outside this editor; edit the latest document.'
)

export const CUSTOM_EDITOR_TOO_LARGE: PluginError = pluginError(
  'too_large',
  'The edit is larger than Orca accepts; the file keeps its last accepted edit.'
)

export type CustomEditorKeyChord = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

function shortString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
}

export function readCustomEditorKeyChord(payload: unknown): CustomEditorKeyChord | null {
  if (!isPluginJsonObject(payload) || !shortString(payload.key) || !shortString(payload.code)) {
    return null
  }
  return {
    key: payload.key,
    code: payload.code,
    metaKey: payload.metaKey === true,
    ctrlKey: payload.ctrlKey === true,
    altKey: payload.altKey === true,
    shiftKey: payload.shiftKey === true
  }
}
