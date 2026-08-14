import { detectLanguage } from '@/lib/language-detect'
import { canPreviewLanguage } from '@/lib/file-preview'

// Why: HTML preview renders the on-disk working-tree file, so combined-diff
// sections only get the affordance when that file still exists and the surface
// is not a historical commit snapshot whose content may not match disk.
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
