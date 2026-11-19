import { textOnlyLabelsCopiedFiles } from '../../../../../../shared/native-chat/input/composer/native-chat-clipboard-event'

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

  const hasImage = await window.api.ui.clipboardHasImage().catch(() => false)
  if (paths.length > 0 && !hasImage) {
    return paths
  }
  if (!hasImage) {
    return []
  }

  const imagePath = await window.api.ui.saveClipboardImageAsTempFile()
  return imagePath ? [imagePath] : []
}
