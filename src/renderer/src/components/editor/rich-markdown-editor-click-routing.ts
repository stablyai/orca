import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import { toast } from 'sonner'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
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
import {
  classifyHtmlSuperscriptLinkAction,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import {
  getRichMarkdownLinkClickIntent,
  isRichMarkdownLinkOpenModifier
} from './rich-markdown-link-click-intent'

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

export type RichMarkdownRuntimeSettings = Parameters<typeof settingsForRuntimeOwner>[0]

type RichMarkdownEditorClickRoutingOptions = {
  activateMarkdownLink: ActivateMarkdownLink
  editorRef: MutableRefObject<Editor | null>
  event: MouseEvent
  filePath: string
  followLinksOnClickRef: MutableRefObject<boolean>
  isMac: boolean
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
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
  followLinksOnClickRef,
  isMac,
  htmlSuperscriptLinkContext,
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
  const sourceSnapshot = htmlSuperscriptLinkContext.getSnapshot()
  const sourceOwner = sourceSnapshot.sourceOwner
  const modifierHeld = isRichMarkdownLinkOpenModifier(event, isMac)
  if (!editor) {
    return false
  }
  const activeEditor = editor
  const clickedNode = view.state.doc.nodeAt(pos)
  if (clickedNode?.type.name === 'image') {
    if (!modifierHeld) {
      return handleSelectionClick()
    }
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
    if (!modifierHeld) {
      return handleSelectionClick()
    }
    onOpenDocLinkRef.current?.(clickedNode.attrs.target as string)
    return true
  }
  if (clickedNode?.type.name === 'richMarkdownHtmlSuperscriptLink') {
    if (!modifierHeld) {
      return handleSelectionClick()
    }
    const href = String(clickedNode.attrs.href ?? '')
    if (!classifyHtmlSuperscriptLinkAction(href, sourceSnapshot)) {
      return true
    }
    const intent = getRichMarkdownLinkClickIntent(event, isMac, false)
    return intent === 'select' ? handleSelectionClick() : activateStandardLink(href, intent)
  }
  const href = getClickedLinkHref(view, pos, event)
  if (!href) {
    return handleSelectionClick()
  }
  const intent = getRichMarkdownLinkClickIntent(event, isMac, followLinksOnClickRef.current)
  if (intent === 'select') {
    return handleSelectionClick()
  }

  return activateStandardLink(href, intent)

  function handleSelectionClick(): false {
    if (!modifierHeld) {
      const selectedComment = getRichMarkdownCommentAtPos(
        activeEditor,
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

  function activateStandardLink(href: string, intent: 'activate' | 'open-in-client-os'): true {
    if (href.startsWith('#')) {
      scrollToAnchorInEditor(rootRef.current, href.slice(1))
      return true
    }
    if (intent === 'open-in-client-os') {
      openMarkdownLinkInClientOs({
        href,
        filePath,
        runtimeEnvironmentId,
        sourceOwner,
        settings,
        worktreeRoot
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

function getClickedLinkHref(view: EditorView, pos: number, event: MouseEvent): string {
  if (event.target instanceof Element) {
    const href = event.target.closest('a[href]')?.getAttribute('href') ?? ''
    if (href) {
      return href
    }
  }
  const linkMark = view.state.doc
    .resolve(pos)
    .marks()
    .find((mark) => mark.type.name === 'link')
  return linkMark ? (linkMark.attrs.href as string) || '' : ''
}

function openMarkdownLinkInClientOs({
  href,
  filePath,
  worktreeRoot,
  runtimeEnvironmentId,
  sourceOwner,
  settings
}: {
  href: string
  filePath: string
  worktreeRoot: string | null
  runtimeEnvironmentId?: string | null
  sourceOwner: HttpLinkSourceOwner
  settings: RichMarkdownRuntimeSettings
}): void {
  if (sourceOwner.kind === 'unknown') {
    return
  }
  const classified = resolveMarkdownLinkTarget(href, filePath, worktreeRoot)
  if (!classified) {
    return
  }
  if (classified.kind === 'external') {
    // Why: deliberate divergence from the preview — this path hands the link to the
    // client OS unconditionally, so it does not follow the invert setting.
    openHttpLink(classified.url, { forceSystemBrowser: true, sourceOwner })
    return
  }
  if (classified.kind === 'anchor') {
    return
  }
  if (
    isLocalPathOpenBlocked(settingsForRuntimeOwner(settings, runtimeEnvironmentId), {
      connectionId: sourceOwner.kind === 'ssh' ? sourceOwner.connectionId : undefined
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
