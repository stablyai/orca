import { textOnlyLabelsCopiedFiles } from '../../../../../../shared/native-chat/input/composer/native-chat-clipboard-event'
import { basename } from '@/lib/path'

export type ClipboardPastePreview =
  | { kind: 'files'; label: string; title: string }
  | { kind: 'image' }

export async function readClipboardPastePreview(): Promise<ClipboardPastePreview | null> {
  let text = ''
  try {
    text = await window.api.ui.readClipboardText()
  } catch {
    // Image-only clipboards may not have readable text.
  }
  const paths = await window.api.ui.readClipboardFilePaths().catch(() => [])
  if (text) {
    return paths.length > 0 && textOnlyLabelsCopiedFiles(text, paths)
      ? describeCopiedPaths(paths)
      : null
  }
  if (paths.length > 0) {
    return describeCopiedPaths(paths)
  }
  return (await window.api.ui.clipboardHasImage().catch(() => false)) ? { kind: 'image' } : null
}

function describeCopiedPaths(paths: string[]): ClipboardPastePreview {
  const names = paths.map(basename)
  return {
    kind: 'files',
    label: names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`,
    title: names.join('\n')
  }
}

export async function readClipboardImportPaths(): Promise<string[]> {
  let text = ''
  try {
    text = await window.api.ui.readClipboardText()
  } catch {
    // Image-only clipboards may not have readable text.
  }
  const paths = await window.api.ui.readClipboardFilePaths().catch(() => [])
  if (text) {
    return paths.length > 0 && textOnlyLabelsCopiedFiles(text, paths) ? paths : []
  }

  if (paths.length > 0) {
    return paths
  }
  const hasImage = await window.api.ui.clipboardHasImage().catch(() => false)
  if (!hasImage) {
    return []
  }

  const imagePath = await window.api.ui.saveClipboardImageAsTempFile()
  return imagePath ? [imagePath] : []
}
