import { translate } from '@/i18n/i18n'

const FILE_LIST_LIMIT = 4

/** The first few extensions and file names, then a count of the rest. */
export function fileList(extensions: readonly string[], filenames: readonly string[]): string {
  const files = [...extensions, ...filenames]
  const shown = files.slice(0, FILE_LIST_LIMIT).join(', ')
  return files.length > FILE_LIST_LIMIT ? `${shown} +${files.length - FILE_LIST_LIMIT}` : shown
}

export function customEditorFileList(editor: {
  extensions: readonly string[]
  filenames: readonly string[]
  binaryFallback?: boolean
}): string {
  return [
    fileList(editor.extensions, editor.filenames),
    editor.binaryFallback
      ? translate(
          'auto.components.plugins.binaryFallback',
          'Unsupported binary files (any file name)'
        )
      : null
  ]
    .filter(Boolean)
    .join(', ')
}
