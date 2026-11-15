import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import {
  isLocalPathOpenBlocked,
  showLocalPathOpenBlockedToast
} from '@/lib/files/os-open/local-path-open-guard'
import { getLinkSourceLocalOpenOwner } from '@/lib/links/ownership/link-source-local-open-owner'
import { openMarkdownExternalUrl } from '../../markdown/link-routing/markdown-external-url-open'
import {
  absolutePathToFileUri as toFileUrlForOsEscape,
  resolveMarkdownLinkTarget
} from '../../markdown/link-routing/markdown-internal-links'
import { openMarkdownFileLinkWithSystemDefault } from '../../markdown/link-routing/markdown-file-link-system-open'
import { scrollToAnchorInEditor } from '../../markdown/navigation/markdown-anchor-scroll'
import { getRichMarkdownCommentAtPos } from '../review/rich-markdown-review-annotations'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { classifyHtmlSuperscriptLinkAction } from '../citations/rich-markdown-html-superscript-link-context'
import type { RichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'
import { getClickedLinkHref } from './rich-markdown-link-dom-events'
import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { HttpLinkSourceOwner } from '@/lib/browser/navigation/http-link-routing'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'

export type ActivateMarkdownLink = (
  href: string,
  context: {
    sourceFilePath: string
    worktreeId: string
    worktreeRoot: string | null
    runtimeEnvironmentId?: string | null
    sourceOwner?: HttpLinkSourceOwner
  }
) => void | Promise<unknown>

type RichMarkdownEditorClickRoutingOptions = {
  activateMarkdownLink: ActivateMarkdownLink
  editorRef: MutableRefObject<Editor | null>
  event: MouseEvent
  filePath: string
  isMac: boolean
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
  markdownCommentsRef: MutableRefObject<DiffComment[]>
  markdownSourceLineOffsetRef: MutableRefObject<number>
  onOpenDocLinkRef: MutableRefObject<((target: string) => void) | undefined>
  pos: number
  rootRef: MutableRefObject<HTMLDivElement | null>
  runtimeEnvironmentId?: string | null
  scrollRichMarkdownReviewNoteCardIntoView: (commentId: string) => void
  view: EditorView
  worktreeId: string
  worktreeRoot: string | null
}

export function handleRichMarkdownEditorClick({
  activateMarkdownLink,
  editorRef,
  event,
  filePath,
  isMac,
  htmlSuperscriptLinkContext,
  markdownCommentsRef,
  markdownSourceLineOffsetRef,
  onOpenDocLinkRef,
  pos,
  rootRef,
  runtimeEnvironmentId,
  scrollRichMarkdownReviewNoteCardIntoView,
  view,
  worktreeId,
  worktreeRoot
}: RichMarkdownEditorClickRoutingOptions): boolean {
  const editor = editorRef.current
  const sourceSnapshot = htmlSuperscriptLinkContext.getSnapshot()
  const sourceOwner = sourceSnapshot.sourceOwner
  const modKey = isMac ? event.metaKey : event.ctrlKey
  if (!editor) {
    return false
  }
  const clickedNode = getClickedNode(view, pos, event)
  if (modKey) {
    if (clickedNode?.type.name === 'image') {
      return activateMarkdownImageClick({
        activateMarkdownLink,
        filePath,
        runtimeEnvironmentId,
        src: (clickedNode.attrs.src as string | undefined) ?? '',
        sourceOwner,
        worktreeId,
        worktreeRoot
      })
    }
    if (clickedNode?.type.name === 'markdownDocLink') {
      onOpenDocLinkRef.current?.(clickedNode.attrs.target as string)
      return true
    }
  }
  const isSuperscriptLink = clickedNode?.type.name === 'richMarkdownHtmlSuperscriptLink'
  const href = isSuperscriptLink
    ? String(clickedNode.attrs.href ?? '')
    : getClickedLinkHref(view, event)
  if (isSuperscriptLink && !classifyHtmlSuperscriptLinkAction(href, sourceSnapshot)) {
    return modKey
  }
  if (href) {
    if (href.startsWith('#')) {
      scrollToAnchorInEditor(rootRef.current, href.slice(1))
      return true
    }
    if (modKey && event.shiftKey) {
      openShiftModifiedMarkdownLink({
        activateMarkdownLink,
        href,
        filePath,
        runtimeEnvironmentId,
        sourceOwner,
        worktreeId,
        worktreeRoot
      })
      return true
    }
    const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
    if (classified?.kind === 'external') {
      openMarkdownExternalUrl(classified.url, {
        state: useAppStore.getState(),
        worktreeId,
        sourceOwner,
        destination: 'orca'
      })
      return true
    }
    void activateMarkdownLink(href, {
      sourceFilePath: filePath,
      worktreeId,
      worktreeRoot,
      runtimeEnvironmentId,
      sourceOwner
    })
    return true
  }
  if (!modKey) {
    const selectedComment = getRichMarkdownCommentAtPos(
      editor,
      markdownCommentsRef.current,
      markdownSourceLineOffsetRef.current,
      pos
    )
    if (selectedComment) {
      scrollRichMarkdownReviewNoteCardIntoView(selectedComment.id)
    }
  }
  return false
}

function activateMarkdownImageClick({
  activateMarkdownLink,
  filePath,
  runtimeEnvironmentId,
  sourceOwner,
  src,
  worktreeId,
  worktreeRoot
}: {
  activateMarkdownLink: ActivateMarkdownLink
  filePath: string
  runtimeEnvironmentId?: string | null
  sourceOwner?: HttpLinkSourceOwner
  src: string
  worktreeId: string
  worktreeRoot: string | null
}): boolean {
  if (!src) {
    return false
  }
  void activateMarkdownLink(src, {
    sourceFilePath: filePath,
    worktreeId,
    worktreeRoot,
    runtimeEnvironmentId,
    sourceOwner
  })
  return true
}

// posAtCoords resolves a click on an inline atom's right half to the position after it.
function getClickedNode(view: EditorView, pos: number, event: MouseEvent): ProseMirrorNode | null {
  const before = view.state.doc.resolve(pos).nodeBefore
  if (
    before?.isAtom &&
    event.target instanceof Node &&
    view.nodeDOM(pos - before.nodeSize)?.contains(event.target)
  ) {
    return before
  }
  return view.state.doc.nodeAt(pos)
}

function openShiftModifiedMarkdownLink({
  activateMarkdownLink,
  href,
  filePath,
  worktreeRoot,
  runtimeEnvironmentId,
  sourceOwner,
  worktreeId
}: {
  activateMarkdownLink: ActivateMarkdownLink
  href: string
  filePath: string
  worktreeRoot: string | null
  runtimeEnvironmentId?: string | null
  sourceOwner: HttpLinkSourceOwner
  worktreeId: string
}): void {
  if (sourceOwner.kind === 'unknown') {
    return
  }
  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  if (!classified) {
    return
  }
  if (classified.kind === 'external') {
    openMarkdownExternalUrl(classified.url, {
      state: useAppStore.getState(),
      worktreeId,
      sourceOwner,
      destination: 'system'
    })
    return
  }
  if (classified.kind === 'anchor') {
    return
  }
  if (
    isLocalPathOpenBlocked(
      runtimeEnvironmentId?.trim()
        ? toRuntimeExecutionHostId(runtimeEnvironmentId.trim())
        : getLinkSourceLocalOpenOwner(useAppStore.getState(), sourceOwner, worktreeId)
    )
  ) {
    // Client-OS Shift-click cannot resolve server-local SSH/runtime paths safely.
    showLocalPathOpenBlockedToast()
    return
  }
  // Scripts main declines to launch open in a tab, like a plain click.
  const openInEditor = (): void =>
    void activateMarkdownLink(href, {
      sourceFilePath: filePath,
      worktreeId,
      worktreeRoot,
      runtimeEnvironmentId,
      sourceOwner
    })
  if (classified.kind === 'markdown') {
    // A click is a user act: it may start the link's stopped WSL distro.
    void window.api.shell
      .pathExists(classified.absolutePath, { wakeWslDistro: true })
      .then((exists) => {
        if (!exists) {
          toast.error(
            translate(
              'auto.components.editor.rich.markdown.editor.click.routing.2d5fb9335d',
              'File not found: {{value0}}',
              { value0: classified.relativePath }
            )
          )
          return
        }
        void openMarkdownFileLinkWithSystemDefault(
          toFileUrlForOsEscape(classified.absolutePath),
          openInEditor
        )
      })
    return
  }
  void openMarkdownFileLinkWithSystemDefault(classified.uri, openInEditor)
}
