import { useRef, type MutableRefObject } from 'react'
import { serializeRichMarkdownForReconcile } from './rich-markdown-reconcile-serializer'
import { createRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import type { RichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import { useFileOwnerRuntimeTarget } from '@/runtime/use-worktree-runtime-target'

type ReconcileRoundTripParams = {
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  filePath: string
  externalSshTargetId?: string
  runtimeEnvironmentId?: string | null
  worktreeId: string
  worktreeRoot: string | null
}

/**
 * Exposes the reconciliation safety serializer as a render-updated ref. It
 * mirrors the live editor's codec/link/image context so the step-6 re-parse
 * matches getMarkdown(), and only runs on commit — so rebuilding the closure
 * each render is cheap and always reflects the latest context.
 */
export function useRichMarkdownReconcileRoundTrip({
  htmlSuperscriptLinkContext,
  filePath,
  externalSshTargetId,
  runtimeEnvironmentId,
  worktreeId,
  worktreeRoot
}: ReconcileRoundTripParams): MutableRefObject<(markdown: string) => string | null> {
  const runtimeTarget = useFileOwnerRuntimeTarget(worktreeId, runtimeEnvironmentId)
  const ref = useRef<(markdown: string) => string | null>(() => null)
  ref.current = (markdown) =>
    serializeRichMarkdownForReconcile(markdown, {
      htmlSuperscriptLinkContext,
      imageResolverContext: createRichMarkdownImageResolverContext({
        filePath,
        externalSshTargetId,
        runtimeTarget,
        worktreeId,
        worktreeRoot
      })
    })
  return ref
}
