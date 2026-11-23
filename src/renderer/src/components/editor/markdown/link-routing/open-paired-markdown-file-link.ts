import { toast } from 'sonner'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { translate } from '@/i18n/i18n'
import { showFileLinkOpenFailureToast } from '@/lib/files/open/file-link-open-failure-toast'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { isMissingRuntimePathError } from '@/runtime/files/metadata/runtime-file-metadata-client'
import { useAppStore } from '@/store/index'
import {
  hostGrantedEditorFields,
  resolvePairedWorkspaceFile
} from '@/components/terminal-pane/host-files/terminal-host-workspace-file'
import { openLinkedFileInEditor } from '@/components/terminal-pane/links/files/terminal-file-link-editor-open'

export async function openPairedMarkdownFileLink({
  absolutePath,
  worktreeId,
  environmentId,
  line,
  column,
  previewAnchor
}: {
  absolutePath: string
  worktreeId: string
  environmentId: string
  line?: number
  column?: number
  previewAnchor?: string
}): Promise<void> {
  const isCurrent = beginLinkOpenRequest()
  let resolved
  try {
    resolved = await resolvePairedWorkspaceFile(environmentId, worktreeId, absolutePath, {
      hostFileOnly: true
    })
  } catch (error) {
    if (isCurrent()) {
      showFileLinkOpenFailureToast(absolutePath, {
        verdict: isMissingRuntimePathError(error) ? 'missing' : 'unverifiable',
        error
      })
    }
    return
  }
  if (!isCurrent() || resolved.kind === 'client') {
    return
  }
  if (resolved.isDirectory) {
    toast.error(
      translate('auto.store.slices.editor.51f15c37d3', 'Cannot open directory: {{value0}}', {
        value0: absolutePath
      })
    )
    return
  }
  const file = {
    filePath: resolved.absolutePath,
    worktreeId: resolved.kind === 'host' ? resolved.worktreeId : worktreeId,
    relativePath: resolved.kind === 'host' ? resolved.relativePath : resolved.absolutePath,
    runtimeEnvironmentId: environmentId,
    ...(resolved.kind === 'grant' ? hostGrantedEditorFields(resolved) : {})
  }
  if (resolved.kind === 'host' && resolved.worktreeId !== worktreeId) {
    activateAndRevealWorkspace(resolved.worktreeId, {
      providesInitialSurface: true,
      executionHostId: resolved.executionHostId
    })
  }
  const language = detectLanguage(file.filePath)
  if (previewAnchor !== undefined && line === undefined && language === 'markdown') {
    useAppStore.getState().openMarkdownPreview({ ...file, language }, { anchor: previewAnchor })
    return
  }
  openLinkedFileInEditor(file, null, { line: line ?? null, column: column ?? null }, isCurrent)
}
