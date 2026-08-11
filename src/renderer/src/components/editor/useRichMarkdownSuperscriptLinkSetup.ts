import { useLayoutEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { resolveRichMarkdownFileOwner } from './rich-markdown-file-owner'

export { resolveRichMarkdownWorktreeRoot } from './rich-markdown-file-owner'

export function useRichMarkdownSuperscriptLinkSetup({
  fileId,
  filePath,
  worktreeId
}: {
  fileId: string
  filePath: string
  worktreeId: string
}) {
  const owner = useAppStore(
    useShallow((state) => {
      const resolved = resolveRichMarkdownFileOwner(state, fileId, filePath, worktreeId)
      const sourceOwner = resolved?.sourceOwner
      return {
        worktreeRoot: resolved?.worktreeRoot ?? null,
        sourceOwnerKind: sourceOwner?.kind ?? 'unknown',
        sourceOwnerId:
          sourceOwner?.kind === 'runtime'
            ? sourceOwner.runtimeEnvironmentId
            : sourceOwner?.kind === 'ssh'
              ? sourceOwner.connectionId
              : null
      }
    })
  )
  const { worktreeRoot } = owner
  const sourceOwner = useMemo<HttpLinkSourceOwner>(() => {
    if (owner.sourceOwnerKind === 'runtime' && owner.sourceOwnerId) {
      return { kind: 'runtime', runtimeEnvironmentId: owner.sourceOwnerId }
    }
    if (owner.sourceOwnerKind === 'ssh' && owner.sourceOwnerId) {
      return { kind: 'ssh', connectionId: owner.sourceOwnerId }
    }
    return owner.sourceOwnerKind === 'local' ? { kind: 'local' } : { kind: 'unknown' }
  }, [owner.sourceOwnerId, owner.sourceOwnerKind])
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
