import { useLayoutEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { createConnectionIdForFileSelector } from '@/lib/connection-owner-resolution'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import type { AppState } from '@/store/types'

export function resolveRichMarkdownWorktreeRoot(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  return workspaceScope?.type === 'folder'
    ? (state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null)
    : (getIndexedWorktreeById(state.worktreesByRepo, worktreeId)?.path ?? null)
}

export function useRichMarkdownSuperscriptLinkSetup({
  filePath,
  runtimeEnvironmentId,
  worktreeId
}: {
  filePath: string
  runtimeEnvironmentId?: string | null
  worktreeId: string
}) {
  const worktreeRoot = useAppStore((state) => resolveRichMarkdownWorktreeRoot(state, worktreeId))
  const runtimeId = runtimeEnvironmentId?.trim()
  const connectionIdSelector = useMemo(() => {
    return createConnectionIdForFileSelector(worktreeId, filePath, { skip: Boolean(runtimeId) })
  }, [filePath, runtimeId, worktreeId])
  const connectionId = useAppStore(connectionIdSelector)
  const sourceOwner = useMemo<HttpLinkSourceOwner>(() => {
    if (runtimeId) {
      return { kind: 'runtime', runtimeEnvironmentId: runtimeId }
    }
    if (connectionId === undefined) {
      return { kind: 'unknown' }
    }
    return connectionId === null ? { kind: 'local' } : { kind: 'ssh', connectionId }
  }, [connectionId, runtimeId])
  const [codec] = useState(createRichMarkdownEditorCodec)
  const [context] = useState(() =>
    createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: filePath,
      worktreeId,
      worktreeRoot,
      sourceOwner
    })
  )
  useLayoutEffect(() => {
    context.update({ sourceFilePath: filePath, worktreeId, worktreeRoot, sourceOwner })
  }, [context, filePath, sourceOwner, worktreeId, worktreeRoot])
  return { codec, htmlSuperscriptLinkContext: context, worktreeRoot }
}
