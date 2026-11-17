import {
  editorChangedFileView,
  type ChangedFileOpenTarget
} from '@/lib/files/open/changed-file-view'

// Preview reads the working file; exclude deleted files and historical snapshots that may differ from it.
export function diffSectionPreviewTarget(params: {
  path: string
  status: string
  isCommitSurface: boolean
  canOpenWorkspaceFileBrowser: boolean
}): Extract<ChangedFileOpenTarget, 'orca-browser' | 'markdown-preview'> | null {
  if (params.isCommitSurface || params.status === 'deleted') {
    return null
  }
  const view = editorChangedFileView(params.path)
  if (view === 'markdown') {
    // Markdown renders in an editor tab that reads through the workspace's own host, not the browser.
    return 'markdown-preview'
  }
  return view === 'page' && params.canOpenWorkspaceFileBrowser ? 'orca-browser' : null
}
