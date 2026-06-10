import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { openHttpLink } from '@/lib/http-link-routing'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import {
  absolutePathToFileUri as toFileUrlForOsEscape,
  resolveMarkdownLinkTarget
} from './markdown-internal-links'
import { scrollToAnchorInEditor } from './markdown-anchor-scroll'
import { getRichMarkdownCommentAtPos } from './rich-markdown-review-annotations'
import type { DiffComment } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

export type ActivateMarkdownLink = (
  href: string,
  context: {
    sourceFilePath: string
    worktreeId: string
    worktreeRoot: string | null
    runtimeEnvironmentId?: string | null
  }
) => void | Promise<unknown>

export type RichMarkdownRuntimeSettings = Parameters<typeof settingsForRuntimeOwner>[0]

type RichMarkdownEditorClickRoutingOptions = {
  activateMarkdownLink: ActivateMarkdownLink
  editorRef: MutableRefObject<Editor | null>
  event: MouseEvent
  filePath: string
  isMac: boolean
  markdownCommentsRef: MutableRefObject<DiffComment[]>
  markdownSourceLineOffsetRef: MutableRefObject<number>
  onOpenDocLinkRef: MutableRefObject<((target: string) => void) | undefined>
  pos: number
  rootRef: MutableRefObject<HTMLDivElement | null>
  runtimeEnvironmentId?: string | null
  scrollRichMarkdownReviewNoteCardIntoView: (commentId: string) => void
  settings: RichMarkdownRuntimeSettings
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
  markdownCommentsRef,
  markdownSourceLineOffsetRef,
  onOpenDocLinkRef,
  pos,
  rootRef,
  runtimeEnvironmentId,
  scrollRichMarkdownReviewNoteCardIntoView,
  settings,
  view,
  worktreeId,
  worktreeRoot
}: RichMarkdownEditorClickRoutingOptions): boolean {
  const editor = editorRef.current
  const modKey = isMac ? event.metaKey : event.ctrlKey
  if (!editor) {
    return false
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
    return false
  }
  const clickedNode = view.state.doc.nodeAt(pos)
  if (clickedNode?.type.name === 'image') {
    return activateMarkdownImageClick({
      activateMarkdownLink,
      filePath,
      runtimeEnvironmentId,
      src: (clickedNode.attrs.src as string | undefined) ?? '',
      worktreeId,
      worktreeRoot
    })
  }
  if (clickedNode?.type.name === 'markdownDocLink') {
    onOpenDocLinkRef.current?.(clickedNode.attrs.target as string)
    return true
  }
  const href = getClickedLinkHref(view, pos)
  if (!href) {
    return false
  }
  if (href.startsWith('#')) {
    scrollToAnchorInEditor(rootRef.current, href.slice(1))
    return true
  }
  if (event.shiftKey) {
    openMarkdownLinkInClientOs({
      href,
      filePath,
      runtimeEnvironmentId,
      settings,
      worktreeId,
      worktreeRoot
    })
    return true
  }
  void activateMarkdownLink(href, {
    sourceFilePath: filePath,
    worktreeId,
    worktreeRoot,
    runtimeEnvironmentId
  })
  return true
}

function activateMarkdownImageClick({
  activateMarkdownLink,
  filePath,
  runtimeEnvironmentId,
  src,
  worktreeId,
  worktreeRoot
}: {
  activateMarkdownLink: ActivateMarkdownLink
  filePath: string
  runtimeEnvironmentId?: string | null
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
    runtimeEnvironmentId
  })
  return true
}

function getClickedLinkHref(view: EditorView, pos: number): string {
  const linkMark = view.state.doc
    .resolve(pos)
    .marks()
    .find((mark) => mark.type.name === 'link')
  return linkMark ? (linkMark.attrs.href as string) || '' : ''
}

function openMarkdownLinkInClientOs({
  href,
  filePath,
  worktreeId,
  worktreeRoot,
  runtimeEnvironmentId,
  settings
}: {
  href: string
  filePath: string
  worktreeId: string
  worktreeRoot: string | null
  runtimeEnvironmentId?: string | null
  settings: RichMarkdownRuntimeSettings
}): void {
  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  if (!classified) {
    return
  }
  if (classified.kind === 'external') {
    openHttpLink(classified.url, { forceSystemBrowser: true })
    return
  }
  if (classified.kind === 'anchor') {
    return
  }
  if (
    isLocalPathOpenBlocked(settingsForRuntimeOwner(settings, runtimeEnvironmentId), {
      connectionId: getConnectionId(worktreeId)
    })
  ) {
    // Why: Shift-click opens through the client OS, which cannot safely resolve
    // server-local paths from SSH or remote runtime worktrees.
    showLocalPathOpenBlockedToast()
    return
  }
  if (classified.kind === 'markdown') {
    void window.api.shell.pathExists(classified.absolutePath).then((exists) => {
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
      void window.api.shell.openFileUri(toFileUrlForOsEscape(classified.absolutePath))
    })
    return
  }
  void window.api.shell.openFileUri(classified.uri)
}
