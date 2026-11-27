// Structural DataTransfer shapes so desktop and the phone's page read paste events with one rule.
type ClipboardFileLike = { readonly name: string }

type ClipboardDataLike<F extends ClipboardFileLike> = {
  readonly items: ArrayLike<{ readonly type: string; getAsFile: () => F | null }>
  readonly files: ArrayLike<F>
  getData: (format: string) => string
}

export type ClipboardEventDataLike<F extends ClipboardFileLike> = {
  readonly clipboardData: ClipboardDataLike<F> | null
}

export function clipboardEventImageFile<F extends ClipboardFileLike>(
  event: ClipboardEventDataLike<F>
): F | null {
  const data = event.clipboardData
  if (!data) {
    return null
  }
  const item = Array.from(data.items).find((candidate) => candidate.type.startsWith('image/'))
  return item?.getAsFile() ?? null
}

function lastPathSegment(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** A label names its file directly (Finder), or by path or file URL (Linux file managers). */
function labelledFileName(line: string): string {
  if (line.startsWith('file://')) {
    try {
      return lastPathSegment(decodeURIComponent(line.replace(/^file:\/\/[^/]*/, '')))
    } catch {
      return line
    }
  }
  return /^(?:\/|[A-Za-z]:[\\/])/.test(line) ? lastPathSegment(line) : line
}

// One label line: a Windows long path (32,767 UTF-16 units) as a file URL, where one unit can encode to 9 chars.
const MAX_LABEL_LINE_CHARS = 9 * 32_768

/** The trimmed lines of `text`, or null once there are more lines than `files` or a line over the cap. */
function labelLines(text: string, files: number): string[] | null {
  const trimmed = text.trim()
  const lines: string[] = []
  let lineStart = 0
  for (let i = 0; i <= trimmed.length; i += 1) {
    const code = i < trimmed.length ? trimmed.charCodeAt(i) : 10
    if (code !== 10 && code !== 13) {
      continue
    }
    const line = trimmed.slice(lineStart, i).trim()
    if (lines.length === files || line.length > MAX_LABEL_LINE_CHARS) {
      return null
    }
    lines.push(line)
    if (code === 13 && trimmed.charCodeAt(i + 1) === 10) {
      i += 1
    }
    lineStart = i + 1
  }
  return lines
}

/** Treat one filename/path/file URL per copied file as attachment labels, not prompt text. */
export function textOnlyLabelsCopiedFiles(text: string, files: readonly string[]): boolean {
  if (files.length === 0) {
    return false
  }
  // Runs on main for every file paste: one linear pass, rejecting prompt text before any per-label work.
  const lines = labelLines(text, files.length)
  if (!lines) {
    return false
  }
  const names = files.map(lastPathSegment).sort()
  const labels = lines.map(labelledFileName).sort()
  return labels.length === names.length && labels.every((label, i) => label === names[i])
}

/** The event's text/plain, unless it only labels the files being attached. */
export function clipboardEventPromptText<F extends ClipboardFileLike>(
  event: ClipboardEventDataLike<F>,
  attachingFile: boolean
): string {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!attachingFile || !text) {
    return text
  }
  const names = Array.from(event.clipboardData?.files ?? [], (file) => file.name)
  return textOnlyLabelsCopiedFiles(text, names) ? '' : text
}
