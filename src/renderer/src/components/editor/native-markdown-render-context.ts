import { createContext, useMemo } from 'react'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { useAppStore } from '@/store'
import { resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { filesystemPathToFileUri } from '../../../../shared/file-uri-path'

export type NativeMarkdownSource = {
  filePath: string
  sourceFileId: string | null
  sourceWorktreeId: string | null
  sourceRuntimeEnvironmentId: string | null | undefined
}

export type NativeMarkdownRenderContextValue = {
  source: NativeMarkdownSource
  ownershipKey?: string
  canRender?: boolean
  openReference: (
    reference: { path: string; base: 'document' | 'workspace' },
    resolved?: { documentPath: string; workspacePath: string }
  ) => void
}

export const NativeMarkdownRenderContext = createContext<NativeMarkdownRenderContextValue | null>(
  null
)

export function useNativeMarkdownRenderContext(
  source: NativeMarkdownSource,
  worktreeRoot: string | null,
  sourceOwner: HttpLinkSourceOwner,
  sourceIdentityMatches = true
): NativeMarkdownRenderContextValue {
  const activateMarkdownLink = useAppStore((state) => state.activateMarkdownLink)
  const { filePath, sourceFileId, sourceWorktreeId, sourceRuntimeEnvironmentId } = source
  return useMemo(
    () => ({
      source: { filePath, sourceFileId, sourceWorktreeId, sourceRuntimeEnvironmentId },
      ownershipKey: JSON.stringify([worktreeRoot, sourceOwner]),
      canRender: sourceIdentityMatches && sourceOwner.kind !== 'unknown',
      openReference: (reference, resolved) => {
        const root = resolved?.workspacePath ?? worktreeRoot
        const documentPath = resolved?.documentPath ?? filePath
        if (!sourceIdentityMatches || !sourceWorktreeId || sourceOwner.kind === 'unknown') {
          return
        }
        if (reference.base === 'workspace' && !root) {
          return
        }
        const href =
          reference.base === 'workspace' && root
            ? filesystemPathToFileUri(resolveRuntimePath(root, reference.path))
            : reference.path.split('/').map(encodeURIComponent).join('/')
        void activateMarkdownLink(href, {
          sourceFilePath: documentPath,
          worktreeId: sourceWorktreeId,
          worktreeRoot: root,
          runtimeEnvironmentId: sourceRuntimeEnvironmentId,
          sourceOwner
        })
      }
    }),
    [
      activateMarkdownLink,
      filePath,
      sourceFileId,
      sourceWorktreeId,
      sourceRuntimeEnvironmentId,
      sourceOwner,
      sourceIdentityMatches,
      worktreeRoot
    ]
  )
}
