const FILE_LIST_LIMIT = 4

/** The first few extensions and file names, then a count of the rest. */
export function fileList(extensions: readonly string[], filenames: readonly string[]): string {
  const files = [...extensions, ...filenames]
  const shown = files.slice(0, FILE_LIST_LIMIT).join(', ')
  return files.length > FILE_LIST_LIMIT ? `${shown} +${files.length - FILE_LIST_LIMIT}` : shown
}
