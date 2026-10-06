import { useCallback } from 'react'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  deriveMarkdownPreviewSourceRoot,
  resolveMarkdownPreviewSourceWorktree
} from './markdown-preview-source-routing'

type PdfLinkSourceFile = Pick<
  OpenFile,
  'filePath' | 'relativePath' | 'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId'
>

/** Where a PDF's relative link resolves from, and which host owns it. */
export function resolvePdfRelativeFileLinkSource(
  file: PdfLinkSourceFile,
  worktreesByRepo: Record<string, Worktree[]>
): { worktreeRoot: string | null; sourceOwner?: HttpLinkSourceOwner } {
  const externalSshTargetId = file.externalSshTargetId?.trim()
  if (externalSshTargetId) {
    // Why: this PDF lives on an SSH host outside the tab's worktree, so the
    // worktree names neither its host nor its root. No root makes every target
    // external, which the link action refuses for a remote owner rather than
    // opening the path on the worktree's host.
    return { worktreeRoot: null, sourceOwner: { kind: 'ssh', connectionId: externalSshTargetId } }
  }
  const worktree = resolveMarkdownPreviewSourceWorktree(
    worktreesByRepo,
    file.worktreeId,
    file.filePath
  )
  return {
    worktreeRoot:
      worktree?.path ?? deriveMarkdownPreviewSourceRoot(file.filePath, file.relativePath)
  }
}

/** Opens a file a PDF links to by relative path, on the host that holds the PDF. */
export function usePdfRelativeFileLinkOpener(file: PdfLinkSourceFile): (href: string) => void {
  const activateMarkdownLink = useAppStore((s) => s.activateMarkdownLink)
  const { filePath, relativePath, worktreeId, runtimeEnvironmentId, externalSshTargetId } = file
  return useCallback(
    (href: string) => {
      // Why: the markdown link action already resolves against the source file,
      // stats on its owning host (local, SSH, runtime), and reports a miss.
      void activateMarkdownLink(href, {
        sourceFilePath: filePath,
        worktreeId,
        runtimeEnvironmentId,
        ...resolvePdfRelativeFileLinkSource(
          { filePath, relativePath, worktreeId, runtimeEnvironmentId, externalSshTargetId },
          useAppStore.getState().worktreesByRepo
        )
      })
    },
    [
      activateMarkdownLink,
      filePath,
      relativePath,
      worktreeId,
      runtimeEnvironmentId,
      externalSshTargetId
    ]
  )
}
