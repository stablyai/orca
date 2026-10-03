import { createBrowserUuid } from '@/lib/browser-uuid'
import { toast } from 'sonner'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildDocPreviewGrantRequest } from '@/lib/doc-preview-grants'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export async function openActiveMarkdownPreviewWindow(options: {
  fileId: string
  root: ParentNode | null
}): Promise<void> {
  try {
    const payload = await getActiveMarkdownExportPayload(options)
    if (!payload) {
      toast.error(
        translate('documentPreview.noRenderedContent', 'Open the rendered preview first.')
      )
      return
    }
    const state = useAppStore.getState()
    const file = state.openFiles.find((candidate) => candidate.id === options.fileId)
    const location = file
      ? buildDocPreviewGrantRequest(state, file.worktreeId, file.filePath)
      : null
    const local =
      file &&
      !file.externalSshTargetId &&
      getConnectionIdForFileFromState(state, file.worktreeId, file.filePath) === null &&
      getRuntimeEnvironmentIdForWorktree(state, file.worktreeId) === null
    if (!file || (!location && !local)) {
      throw new Error('The document host is still resolving. Try again once it is connected.')
    }
    const { followMarkdownPreviewWindow } = await import('./live-markdown-preview-window')
    if (local) {
      await window.api.docPreview.openMarkdownWindow({ ...payload, fileId: file.id })
      followMarkdownPreviewWindow(file, payload, {
        settings: null,
        filePath: file.filePath,
        relativePath: file.relativePath,
        worktreeId: file.worktreeId
      })
      return
    }
    if (!location) {
      throw new Error('The document host is unavailable.')
    }
    const grant = await window.api.docPreview.mintGrant({
      ...location,
      browserPageId: `markdown-source:${createBrowserUuid()}`
    })
    try {
      await window.api.docPreview.openMarkdownWindow({
        ...payload,
        fileId: file.id,
        sourceGrantId: grant.grantId
      })
      followMarkdownPreviewWindow(
        {
          ...file,
          runtimeEnvironmentId:
            location.owner.kind === 'runtime'
              ? location.owner.environmentId
              : file.runtimeEnvironmentId
        },
        payload
      )
    } finally {
      await window.api.docPreview.revokeGrant(grant.grantId)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Unable to open preview window')
  }
}
