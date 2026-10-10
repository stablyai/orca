import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import type { EditorView } from '@tiptap/pm/view'
import { toast } from 'sonner'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { httpLinkActionDestinationsFor, openRoutedHttpLink } from '@/lib/http-link-destinations'
import { useAppStore } from '@/store'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-tab-open'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { getLinkSourceLocalOpenOwner } from '@/lib/link-source-local-open-owner'
import type { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import {
  absolutePathToFileUri as toFileUrlForOsEscape,
  resolveMarkdownLinkTarget
} from './markdown-internal-links'
import { scrollToAnchorInEditor } from './markdown-anchor-scroll'
import { getRichMarkdownCommentAtPos } from './rich-markdown-review-annotations'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import {
  classifyHtmlSuperscriptLinkAction,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'

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
      sourceOwner,
      worktreeId,
      worktreeRoot
    })
  }
  if (clickedNode?.type.name === 'markdownDocLink') {
    onOpenDocLinkRef.current?.(clickedNode.attrs.target as string)
    return true
  }
  const href =
    clickedNode?.type.name === 'richMarkdownHtmlSuperscriptLink'
      ? String(clickedNode.attrs.href ?? '')
      : getClickedLinkHref(view, pos)
  if (
    clickedNode?.type.name === 'richMarkdownHtmlSuperscriptLink' &&
    !classifyHtmlSuperscriptLinkAction(href, sourceSnapshot)
  ) {
    return true
  }
  if (!href) {
    return false
  }
  if (href.startsWith('#')) {
    scrollToAnchorInEditor(rootRef.current, href.slice(1))
    return true
  }
  if (event.shiftKey) {
    openShiftModifiedMarkdownLink({
      href,
      filePath,
      runtimeEnvironmentId,
      sourceOwner,
      worktreeId,
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

function getClickedLinkHref(view: EditorView, pos: number): string {
  const linkMark = view.state.doc
    .resolve(pos)
    .marks()
    .find((mark) => mark.type.name === 'link')
  return linkMark ? (linkMark.attrs.href as string) || '' : ''
}

function openShiftModifiedMarkdownLink({
  href,
  filePath,
  worktreeRoot,
  runtimeEnvironmentId,
  sourceOwner,
  worktreeId
}: {
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
    const state = useAppStore.getState()
    const canOpenOwnedBrowser =
      sourceOwner.kind === 'runtime'
        ? canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, sourceOwner.runtimeEnvironmentId)
        : sourceOwner.kind === 'ssh' &&
          canOpenWorkspaceBrowserTabOnSsh(state, worktreeId, sourceOwner.connectionId)
    const destinations = httpLinkActionDestinationsFor(
      state.settings,
      sourceOwner,
      canOpenOwnedBrowser
    )
    openRoutedHttpLink(classified.url, {
      worktreeId,
      sourceOwner,
      forceDestination: destinations.alternate ?? destinations.primary
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
      void window.api.shell.openFileUri(
        toFileUrlForOsEscape(classified.absolutePath),
        LOCAL_EXECUTION_HOST_ID
      )
    })
    return
  }
  void window.api.shell.openFileUri(classified.uri, LOCAL_EXECUTION_HOST_ID)
}
