import { isMacPlatform } from './native-chat-shortcut'

/** Accept native pane clipboard events and React synthetic events. */
export type ClipboardEventLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  defaultPrevented: boolean
}

export function clipboardEventImageFile(event: ClipboardEventLike): File | null {
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
export function clipboardEventPromptText(
  event: ClipboardEventLike,
  attachingFile: boolean
): string {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!attachingFile || !text) {
    return text
  }
  const names = Array.from(event.clipboardData?.files ?? [], (file) => file.name)
  return textOnlyLabelsCopiedFiles(text, names) ? '' : text
}

/** Use drop-style resolution only when every copied file has a local path and text contains labels alone. */
export function clipboardEventCopiedFilePaths(event: ClipboardEventLike): string[] {
  const files = Array.from(event.clipboardData?.files ?? [])
  const fs = window.api?.fs
  // The web fallback proxy fabricates methods absent from the concrete namespace.
  const getPathForFile = fs && 'getPathForFile' in fs ? fs.getPathForFile : undefined
  if (files.length === 0 || !getPathForFile) {
    return []
  }
  const paths: string[] = []
  for (const file of files) {
    let path = ''
    try {
      path = getPathForFile(file)
    } catch {
      // A pasted bitmap has no file behind it.
    }
    if (!path) {
      return []
    }
    paths.push(path)
  }
  return copiesOnlyFiles(event.clipboardData?.getData('text/plain') ?? '', paths) ? paths : []
}

function copiesOnlyFiles(text: string, filePaths: readonly string[]): boolean {
  return filePaths.length > 0 && (text === '' || textOnlyLabelsCopiedFiles(text, filePaths))
}

/** Separate copied-file labels from prompt text; reuse eventFilePaths when the event already resolved them. */
export async function readClipboardPasteText(
  maxBytes: number,
  eventFilePaths?: string[]
): Promise<{ text: string; copiedFilePaths: string[] }> {
  const [text, filePaths] = await Promise.all([
    window.api.ui.readClipboardText({ maxBytes }),
    // Without the file list the text is typed as-is.
    eventFilePaths ?? window.api.ui.readClipboardFilePaths().catch(() => [])
  ])
  if (!copiesOnlyFiles(text, filePaths)) {
    return { text, copiedFilePaths: [] }
  }
  // macOS lists a screenshot tool's saved file beside its picture; only Finder also names files.
  const picture = text === '' && isMacPlatform() && (await window.api.ui.clipboardHasImage())
  return { text, copiedFilePaths: picture ? [] : filePaths }
}
