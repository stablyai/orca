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

/** Treat one filename/path/file URL per copied file as attachment labels, not prompt text. */
export function textOnlyLabelsCopiedFiles(text: string, files: readonly string[]): boolean {
  if (files.length === 0) {
    return false
  }
  const names = files.map(lastPathSegment).sort()
  const labels = text
    .trim()
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
