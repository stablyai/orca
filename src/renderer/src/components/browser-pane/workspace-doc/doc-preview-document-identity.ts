import { basename, getRelativePathInsideRoot } from '@/lib/path'

export type DocPreviewDocumentIdentity = {
  /** What clicking the chip copies — always the path as the owning machine spells it. */
  absolutePath: string
  /** Workspace-relative directory with a trailing separator; empty at the workspace root. */
  directoryPrefix: string
  fileName: string
  /** Null while ownership is unknown, so the chip can drop the pill instead of inventing a host. */
  hostLabel: string | null
}

/**
 * What the preview toolbar shows instead of a URL. The reader never sees the internal preview
 * origin, so the document has to identify itself: where it sits in the workspace, and whose disk
 * that is.
 */
export function buildDocPreviewDocumentIdentity({
  filePath,
  worktreeRoot,
  hostLabel
}: {
  filePath: string
  worktreeRoot: string | null
  hostLabel: string | null
}): DocPreviewDocumentIdentity {
  // Why fall back to the absolute path: an SSH preview of a file outside the workspace has no
  // workspace-relative form, and a bare filename would strip the only context the reader has.
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
