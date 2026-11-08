import { isMacPlatform } from '../pane/routing/native-chat-shortcut'
import { textOnlyLabelsCopiedFiles } from '../../../../../shared/native-chat/input/native-chat-clipboard-event'

/** Accept native pane clipboard events and React synthetic events. */
export type ClipboardEventLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  defaultPrevented: boolean
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
