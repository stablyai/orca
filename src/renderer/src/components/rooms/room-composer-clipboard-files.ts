type ClipboardFileItem = Pick<DataTransferItem, 'kind' | 'getAsFile'> & {
  webkitGetAsEntry?: () => { isDirectory: boolean } | null
}

export function getRoomComposerClipboardFiles(data: {
  files: ArrayLike<File>
  items: ArrayLike<ClipboardFileItem>
}): File[] {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file')
  const itemFiles = items.flatMap((item) => {
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      return []
    }
    const file = item.getAsFile()
    return file ? [file] : []
  })
  const files = Array.from(data.files ?? [])
  return (itemFiles.length > files.length ? itemFiles : files).map(normalizeClipboardFileName)
}

function normalizeClipboardFileName(file: File, index: number): File {
  if (file.name.trim()) {
    return file
  }
  const extension =
    {
      'image/gif': '.gif',
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp'
    }[file.type] ?? ''
  return new File([file], `pasted-file-${index + 1}${extension}`, {
    type: file.type,
    lastModified: file.lastModified
  })
}
