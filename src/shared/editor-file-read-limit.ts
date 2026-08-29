/**
 * One definition of how many bytes the editor will pull over each transport,
 * plus a machine-readable refusal so the renderer can degrade to an explanatory
 * view instead of a dead "Unable to load file" box.
 *
 * The values deliberately differ per transport and are NOT converging: a local
 * read is a page-cache copy, an SSH read crosses a bounded RPC transport where
 * a large transfer stalls the interactive lanes. Reporting the transport in the
 * refusal is what keeps that honest — the fallback names the limit that was
 * actually applied rather than claiming one shared number.
 */

/** Transport that produced the bytes, not the workspace kind. */
export type EditorFileReadScope = 'local' | 'ssh' | 'runtime'

export const EDITOR_TEXT_READ_LIMIT_BYTES: Record<'local' | 'ssh', number> = {
  local: 50 * 1024 * 1024,
  ssh: 10 * 1024 * 1024
}

/** Previewable binaries are base64 blobs the editor never parses as text. */
export const EDITOR_PREVIEWABLE_BINARY_MAX_BYTES = 50 * 1024 * 1024

/**
 * The editor model decides at construction that it is too large for any
 * whole-buffer read, and Orca takes one on every editor mount (content sync)
 * and every save. Past this it throws instead of returning text. utf-8 never
 * decodes to more UTF-16 code units than input bytes, so bounding bytes bounds
 * characters. Pinned against the model's own constant in
 * monaco-large-file-optimizations.test.ts.
 */
export const MONACO_HEAP_OPERATION_LIMIT_BYTES = 256 * 1024 * 1024

/**
 * Ceiling on a read whose budget the user overruled. The budgets above are
 * confirmations — "this will be slow, proceed?" — but the local transport still
 * materializes the whole file as one Buffer and one JS string that is cloned
 * whole into the renderer, and V8 cannot represent a string past
 * `buffer.constants.MAX_STRING_LENGTH`. Without a ceiling the override turns a
 * parseable refusal into an allocation throw that the retry gate reads as
 * transient, so it retries into the same wall.
 *
 * Derived, not chosen, from the two walls the overridden bytes have to clear:
 * base64 turns 3 bytes into 4 characters, so V8's string cap fixes one bound;
 * the model's heap-operation limit fixes the other, and it is the lower of the
 * two. Admitting bytes between them buys a tab that throws on mount and on
 * save rather than a tab that is merely slow.
 */
const V8_MAX_STRING_LENGTH = 536_870_888
export const EDITOR_READ_OVERRIDE_CEILING_BYTES = Math.min(
  Math.floor(V8_MAX_STRING_LENGTH / 4) * 3,
  MONACO_HEAP_OPERATION_LIMIT_BYTES
)

/**
 * Every field is optional because a refuser only reports what it measured: a
 * host that caps its read knows the budget but never the file's size, and the
 * bare `file_too_large` protocol token carries neither. Absent means unobserved,
 * so the fallback omits the row rather than printing a number nobody checked.
 */
export type FileTooLargeDetail = {
  byteLength?: number
  limitBytes?: number
  scope?: EditorFileReadScope
}

const SCOPE_SUBJECT: Record<EditorFileReadScope, string> = {
  local: 'local files',
  ssh: 'files on this SSH host',
  runtime: 'files on this remote workspace'
}

// Why: parsed out of a message rather than a typed error because the refusal
// crosses ipcRenderer.invoke and the relay, both of which flatten errors to a
// string and prepend their own wrapper text.
const MARKER_PATTERN = /\[((?:size|limit|scope)=[^\]]*)\]/
// Hosts that cannot attach a marker refuse with this bare protocol token.
const PROTOCOL_TOKEN_PATTERN = /(?<![A-Za-z0-9_])file_too_large(?![A-Za-z0-9_])/
// Why: the marker is addressed to the editor's fallback, not to a reader. Any
// surface that prints the raw refusal as prose has to drop it first.
const APPENDED_MARKER_PATTERN = /\s*\[(?:file_too_large|(?:size|limit|scope)=[^\]]*)\]/g

const BYTE_UNITS = [
  { label: 'GB', bytes: 1024 * 1024 * 1024 },
  { label: 'MB', bytes: 1024 * 1024 },
  { label: 'KB', bytes: 1024 }
] as const

/**
 * The one formatter for every byte count the editor shows a user. Fixing the
 * unit at MB mislabelled sub-MB budgets ("0.5MB exceeds the 1MB read limit"),
 * and a second formatter elsewhere let a size and its own limit disagree.
 */
export function formatFileReadBytes(bytes: number): string {
  for (const unit of BYTE_UNITS) {
    if (bytes >= unit.bytes) {
      return `${(bytes / unit.bytes).toFixed(1)} ${unit.label}`
    }
  }
  return `${Math.max(0, Math.round(bytes))} B`
}

export function formatFileTooLargeMessage({
  byteLength,
  limitBytes,
  scope
}: FileTooLargeDetail): string {
  const limitClause =
    limitBytes === undefined
      ? 'the read limit'
      : `the ${formatFileReadBytes(limitBytes)} read limit`
  const subjectClause = scope === undefined ? '' : ` for ${SCOPE_SUBJECT[scope]}`
  const sentence =
    byteLength === undefined
      ? `File too large: over ${limitClause}${subjectClause}.`
      : `File too large: ${formatFileReadBytes(byteLength)} exceeds ${limitClause}${subjectClause}.`
  const marker = [
    byteLength === undefined ? null : `size=${byteLength}`,
    limitBytes === undefined ? null : `limit=${limitBytes}`,
    scope === undefined ? null : `scope=${scope}`
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
  return `${sentence} [${marker === '' ? 'file_too_large' : marker}]`
}

/**
 * Whether re-reading with the budget lifted could still succeed. A refusal names
 * the limit that stopped it, so a limit already at the ceiling leaves the
 * override nothing to lift, and only the local transport answers to this client
 * at all — SSH and runtime caps bound a connection shared with the interactive
 * lanes. An unreported scope named no transport, so nothing was observed that
 * would justify offering the override.
 */
export function isOverridableFileTooLarge(detail: FileTooLargeDetail): boolean {
  return (
    detail.scope === 'local' &&
    (detail.limitBytes === undefined || detail.limitBytes < EDITOR_READ_OVERRIDE_CEILING_BYTES)
  )
}

export function parseFileTooLargeMessage(message: string): FileTooLargeDetail | null {
  const marker = MARKER_PATTERN.exec(message)
  if (marker) {
    const size = /(?:^|\s)size=(\d+)/.exec(marker[1])
    const limit = /(?:^|\s)limit=(\d+)/.exec(marker[1])
    const scope = /(?:^|\s)scope=(local|ssh|runtime)/.exec(marker[1])
    return {
      ...(size ? { byteLength: Number(size[1]) } : {}),
      ...(limit ? { limitBytes: Number(limit[1]) } : {}),
      ...(scope ? { scope: scope[1] as EditorFileReadScope } : {})
    }
  }
  return PROTOCOL_TOKEN_PATTERN.test(message) ? {} : null
}

/**
 * Strip the machine marker so a refusal can be shown verbatim. The relay's file
 * reader is shared with the AI Vault scanner, whose issue rows render the raw
 * message, so the marker would otherwise appear in the sidebar.
 */
export function stripFileTooLargeMarker(message: string): string {
  return message.replace(APPENDED_MARKER_PATTERN, '').trimEnd()
}
