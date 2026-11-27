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
  return path.split(/[\\/]/).pop() ?? path
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

const OUTER_WHITESPACE = /\s/

/** `text`'s bounds without outer whitespace, or null once it has more lines than `files` or an over-long line. */
function labelTextBounds(text: string, files: number): { start: number; end: number } | null {
  let start = 0
  while (start < text.length && OUTER_WHITESPACE.test(text[start])) {
    start += 1
  }
  let end = text.length
  while (end > start && OUTER_WHITESPACE.test(text[end - 1])) {
    end -= 1
  }
  let lines = 1
  let lineStart = start
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i)
    if (code !== 10 && code !== 13) {
      if (i - lineStart >= MAX_LABEL_LINE_CHARS) {
        return null
      }
      continue
    }
    if (code === 13 && text.charCodeAt(i + 1) === 10) {
      i += 1
    }
    lines += 1
    if (lines > files) {
      return null
    }
    lineStart = i + 1
  }
  return { start, end }
}

/** Treat one filename/path/file URL per copied file as attachment labels, not prompt text. */
export function textOnlyLabelsCopiedFiles(text: string, files: readonly string[]): boolean {
  if (files.length === 0) {
    return false
  }
  // Runs on main for every file paste: reject prompt text that can't be labels before any split or sort.
  const bounds = labelTextBounds(text, files.length)
  if (!bounds) {
    return false
  }
  const names = files.map(lastPathSegment).sort()
  const labels = text
    .slice(bounds.start, bounds.end)
    .split(/\r\n|\r|\n/)
    .map((line) => labelledFileName(line.trim()))
    .sort()
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
