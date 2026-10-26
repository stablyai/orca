import { detectLanguage } from '@/lib/language-detect'
import { canPreviewLanguage } from '@/lib/file-preview'

// Preview reads the working file on disk; exclude deleted files and historical snapshots that may differ from it.
export function canOpenDiffSectionPreviewToSide(params: {
  path: string
  status: string
  isCommitSurface: boolean
  canOpenWorkspaceFileBrowser: boolean
}): boolean {
  if (!params.canOpenWorkspaceFileBrowser) {
    return false
  }
  if (params.isCommitSurface) {
    return false
  }
  if (params.status === 'deleted') {
    return false
  }
  return canPreviewLanguage(detectLanguage(params.path))
}
