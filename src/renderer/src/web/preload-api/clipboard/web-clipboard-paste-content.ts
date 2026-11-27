import { clipboardHasImage } from './web-clipboard-api'
import { getBrowserPlatform } from '../web-storage'
import {
  assertClipboardTextWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../../../../shared/clipboard/clipboard-text'
import {
  shouldProbeClipboardPasteImage,
  type ClipboardPasteContent,
  type ReadClipboardPasteContentOptions
} from '../../../../../shared/clipboard/clipboard-paste-content'

export async function readWebClipboardText(options?: ReadClipboardTextOptions): Promise<string> {
  return assertClipboardTextWithinLimitWithYield(
    await (navigator.clipboard?.readText?.() ?? ''),
    options
  )
}

/** Browsers expose copied files and HTML only inside a paste event; a programmatic HTML read would prompt. */
export async function readWebClipboardPasteContent(
  options?: ReadClipboardPasteContentOptions
): Promise<ClipboardPasteContent> {
  const text = await readWebClipboardText(options)
  const filePaths: string[] = []
  // Each browser clipboard read can prompt, so probe only when the caller needs the answer.
  if (!shouldProbeClipboardPasteImage(options?.imageProbe, text, filePaths, getBrowserPlatform())) {
    return { text, filePaths, linkHtml: '', hasImage: null }
  }
  try {
    return {
      text,
      filePaths,
      linkHtml: '',
      hasImage: (await clipboardHasImage()) === true
    }
  } catch (error) {
    const imageProbeError = error instanceof Error ? error.message : String(error)
    return { text, filePaths, linkHtml: '', hasImage: false, imageProbeError }
  }
}
