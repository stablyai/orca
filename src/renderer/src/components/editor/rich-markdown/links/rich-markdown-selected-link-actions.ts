import { getMarkRange } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { getLinkBubblePosition, type LinkBubbleState } from './RichMarkdownLinkBubble'
import { scrollToAnchorInEditor } from '../../markdown/navigation/markdown-anchor-scroll'
import type { ActivateMarkdownLink } from './rich-markdown-editor-click-routing'
import {
  classifyHtmlSuperscriptLinkAction,
  type RichMarkdownHtmlSuperscriptLinkContext
} from '../citations/rich-markdown-html-superscript-link-context'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function createEditableMarkdownLinkBubble(
  href: string,
  position: Pick<LinkBubbleState, 'left' | 'top'>,
  targetRange?: { from: number; to: number }
): LinkBubbleState {
  return {
    kind: 'markdown',
    href,
    copyEnabled: Boolean(href),
    targetRange,
    ...position
  }
}

export function getRichMarkdownSelectionLinkBubble(
  editor: Editor,
  root: HTMLElement | null
): LinkBubbleState | null {
  const position = getLinkBubblePosition(editor, root)
  if (!position) {
    return null
  }
  if (editor.isActive('link')) {
    const attrs = editor.getAttributes('link')
    const linkMarkType = editor.state.schema.marks.link
    const targetRange = linkMarkType
      ? getMarkRange(editor.state.selection.$from, linkMarkType, attrs) || undefined
      : undefined
    return createEditableMarkdownLinkBubble(String(attrs.href ?? ''), position, targetRange)
  }
  const selection = editor.state.selection
  if (
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== 'richMarkdownHtmlSuperscriptLink'
  ) {
    return null
  }
  const href = String(selection.node.attrs.href ?? '')
  return {
    kind: 'html-superscript',
    href,
    label: String(selection.node.attrs.label ?? ''),
    copyEnabled: Boolean(href),
    ...position
  }
}

export function getSelectedHtmlSuperscriptLinkStatus(
  editor: Editor | null,
  context: RichMarkdownHtmlSuperscriptLinkContext
): { href: string; label: string; openEnabled: boolean } | null {
  const selection = editor?.state.selection
  if (
    !editor ||
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== 'richMarkdownHtmlSuperscriptLink'
  ) {
    return null
  }
  const href = String(selection.node.attrs.href ?? '')
  return {
    href,
    label: String(selection.node.attrs.label ?? ''),
    openEnabled: classifyHtmlSuperscriptLinkAction(href, context.getSnapshot())
  }
}

export function formatSelectedHtmlSuperscriptLinkStatus(
  status: NonNullable<ReturnType<typeof getSelectedHtmlSuperscriptLinkStatus>>,
  t: Translate = translate
): string {
  const label =
    status.label || t('auto.components.editor.RichMarkdownEditor.citationFallbackLabel', 'Citation')
  if (status.openEnabled) {
    return t(
      'auto.components.editor.RichMarkdownEditor.citationLinkAvailable',
      '{{value0}}, link to {{value1}}. Press Enter to open or Tab for link actions.',
      { value0: label, value1: status.href }
    )
  }
  const actionHint = status.href
    ? t(
        'auto.components.editor.RichMarkdownEditor.tabForCitationActions',
        'Tab for available actions.'
      )
    : t(
        'auto.components.editor.RichMarkdownEditor.noCitationActions',
        'No link actions are available.'
      )
  return t(
    'auto.components.editor.RichMarkdownEditor.citationLinkUnavailable',
    '{{value0}}, citation link unavailable. {{value1}}',
    { value0: label, value1: actionHint }
  )
}

export function openSelectedHtmlSuperscriptLink({
  activateMarkdownLink,
  context,
  editor,
  root,
  runtimeEnvironmentId
}: {
  activateMarkdownLink: ActivateMarkdownLink
  context: RichMarkdownHtmlSuperscriptLinkContext
  editor: Editor | null
  root: HTMLElement | null
  runtimeEnvironmentId?: string | null
}): boolean {
  const selection = editor?.state.selection
  if (
    !editor ||
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== 'richMarkdownHtmlSuperscriptLink'
  ) {
    return false
  }
  const href = String(selection.node.attrs.href ?? '')
  const snapshot = context.getSnapshot()
  if (!classifyHtmlSuperscriptLinkAction(href, snapshot)) {
    return true
  }
  if (href.startsWith('#')) {
    scrollToAnchorInEditor(root, href.slice(1))
    return true
  }
  void activateMarkdownLink(href, {
    sourceFilePath: snapshot.sourceFilePath,
    worktreeId: snapshot.worktreeId,
    worktreeRoot: snapshot.worktreeRoot,
    runtimeEnvironmentId,
    sourceOwner: snapshot.sourceOwner
  })
  return true
}
