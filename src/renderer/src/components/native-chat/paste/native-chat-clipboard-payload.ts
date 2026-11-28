import { isMacPlatform } from '../pane/routing/native-chat-shortcut'
import {
  clipboardEventPromptText,
  textOnlyLabelsCopiedFiles
} from '../../../../../shared/native-chat/input/composer/native-chat-clipboard-event'
import { withPastedLinks } from './native-chat-pasted-links'
import type { ClipboardPasteImageProbe } from '../../../../../shared/clipboard/clipboard-paste-content'

/** Copied files whose text, if any, only names them: they attach as files, not prompt text. */
function copiesOnlyFiles(text: string, filePaths: readonly string[]): boolean {
  return filePaths.length > 0 && (text === '' || textOnlyLabelsCopiedFiles(text, filePaths))
}

/** Accept native pane clipboard events and React synthetic events. */
export type ClipboardEventLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  defaultPrevented: boolean
}

/** Use drop-style resolution only when every copied file has a local path and text contains labels alone. */
export function clipboardEventCopiedFilePaths(event: ClipboardEventLike): string[] {
  const fs = window.api?.fs
  // The web fallback proxy fabricates methods absent from the concrete namespace.
  const getPathForFile = fs && 'getPathForFile' in fs ? fs.getPathForFile : undefined
  if (!getPathForFile) {
    return []
  }
  // Read files only once a path can resolve; Chromium encodes clipboard bitmaps synchronously here.
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length === 0) {
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

/** The event's prompt text, with any rich-text links kept as Markdown. */
export function clipboardEventPastedText(
  event: ClipboardEventLike,
  attachingFile: boolean
): string {
  return withPastedLinks(
    clipboardEventPromptText(event, attachingFile),
    event.clipboardData?.getData('text/html')
  )
}

/** Separate copied-file labels from prompt text; reuse eventFilePaths when the event already resolved them. */
type ClipboardPasteRead = {
  text: string
  copiedFilePaths: string[]
  /** Null when the read skipped the image check. */
  hasImage: boolean | null
  imageProbeError?: string
}

/** Image presence after a menu paste: the read's own check when it ran, else one more check. */
export async function clipboardPasteHasImage(
  read: ClipboardPasteRead | null,
  onError: (error: unknown) => void
): Promise<boolean> {
  if (read?.imageProbeError) {
    onError(new Error(read.imageProbeError))
    return false
  }
  if (read && read.hasImage !== null) {
    return read.hasImage
  }
  // A failed read (e.g. text too large) or a skipped check (web, or files beside prompt text) can still carry a picture.
  return window.api.ui.clipboardHasImage().then(
    (hasImage) => hasImage === true,
    (error) => {
      // A failed read already showed its own notice.
      if (read) {
        onError(error)
      }
      return false
    }
  )
}

export async function readClipboardPasteText(
  maxBytes: number,
  {
    eventFilePaths,
    imageProbe = 'without-text'
  }: { eventFilePaths?: string[]; imageProbe?: ClipboardPasteImageProbe } = {}
): Promise<ClipboardPasteRead> {
  const read = await window.api.ui.readClipboardPasteContent({
    maxBytes,
    linkHtml: true,
    imageProbe,
    skipFilePaths: eventFilePaths !== undefined
  })
  const { text, hasImage, imageProbeError } = read
  const filePaths = eventFilePaths ?? read.filePaths
  if (!copiesOnlyFiles(text, filePaths)) {
    return {
      text: withPastedLinks(text, read.linkHtml),
      copiedFilePaths: [],
      hasImage,
      imageProbeError
    }
  }
  // macOS lists a screenshot tool's saved file beside its picture; only Finder also names files.
  const picture = text === '' && isMacPlatform() && hasImage === true
  return { text, copiedFilePaths: picture ? [] : filePaths, hasImage, imageProbeError }
}
