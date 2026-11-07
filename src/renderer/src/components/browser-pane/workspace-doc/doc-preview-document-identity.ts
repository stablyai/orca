import { basename, getRelativePathInsideRoot } from '@/lib/path'

export type DocPreviewDocumentIdentity = {
  /** Copy path as spelled by the owning machine; a click may instead begin address editing. */
  absolutePath: string
  /** Workspace-relative directory with a trailing separator; empty at the workspace root. */
  directoryPrefix: string
  fileName: string
  /** Null while ownership is unknown, so the chip can drop the pill instead of inventing a host. */
  hostLabel: string | null
}

export function buildDocPreviewDocumentIdentity({
  filePath,
  worktreeRoot,
  hostLabel
}: {
  filePath: string
  worktreeRoot: string | null
  hostLabel: string | null
}): DocPreviewDocumentIdentity {
  // External SSH files have no relative form; retain the absolute path as location context.
  const displayPath = getRelativePathInsideRoot(filePath, worktreeRoot) ?? filePath
  const fileName = basename(displayPath)
  return {
    absolutePath: filePath,
    // Sliced rather than rebuilt from dirname so the owner's own separator survives on Windows.
    directoryPrefix: displayPath.slice(0, displayPath.length - fileName.length),
    fileName,
    hostLabel
  }
}
