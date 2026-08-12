export type ComposerNativeFileDropUpload = {
  filePaths: string[]
  folderPaths: string[]
}

type ComposerNativeFileDropArgs = {
  paths: string[]
  isCurrentOwner: () => boolean
  uploadPaths: (paths: string[]) => Promise<ComposerNativeFileDropUpload | null>
  applyLocalPaths: (paths: string[], isCurrentOwner: () => boolean) => Promise<void>
  addAttachments: (paths: string[]) => void
  insertFolderPaths: (paths: string[]) => void
  onError: (error: unknown) => void
}

export async function applyComposerNativeFileDrop(args: ComposerNativeFileDropArgs): Promise<void> {
  try {
    const uploaded = await args.uploadPaths(args.paths)
    if (!args.isCurrentOwner()) {
      return
    }
    if (uploaded) {
      args.addAttachments(uploaded.filePaths)
      args.insertFolderPaths(uploaded.folderPaths)
      return
    }
    await args.applyLocalPaths(args.paths, args.isCurrentOwner)
  } catch (error) {
    // Why: an unmounted composer no longer owns the user-facing failure.
    if (args.isCurrentOwner()) {
      args.onError(error)
    }
  }
}
