import type { JSONContent } from '@tiptap/core'
import { formatNativeChatFileReference } from '../native-chat/native-chat-composer-target'
import { shellEscapePath } from './pane-helpers'
import type { TerminalTargetShell } from './terminal-drop-shell'
import type { TerminalRichInputImageAttachment } from './terminal-rich-input-types'

export const TERMINAL_RICH_INPUT_FILE_MENTION_NODE = 'terminalFileMention'
export const TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE = 'terminalImageAttachment'
export const TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER = '\u200B'
export const TERMINAL_RICH_INPUT_IMAGE_INSERTION_SIZE = 2

export type TerminalRichInputResourceContext = {
  connectionId: string | null
  runtimeEnvironmentId: string | null
  worktreeId: string
  worktreePath: string
}

export function terminalRichInputImageAttachmentsToContent(
  attachments: readonly TerminalRichInputImageAttachment[],
  context: TerminalRichInputResourceContext
): JSONContent[] {
  return attachments.flatMap((attachment) => [
    {
      type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
      attrs: {
        id: attachment.id,
        path: attachment.path,
        ...(attachment.previewSrc ? { previewSrc: attachment.previewSrc } : {}),
        connectionId: context.connectionId,
        runtimeEnvironmentId: context.runtimeEnvironmentId,
        worktreeId: context.worktreeId,
        worktreePath: context.worktreePath
      }
    },
    { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER }
  ])
}

export function terminalRichInputImageAttachments(
  content: JSONContent
): TerminalRichInputImageAttachment[] {
  const attachments: TerminalRichInputImageAttachment[] = []
  visitContent(content, (node) => {
    if (node.type !== TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
      return
    }
    const id = String(node.attrs?.id ?? '')
    const path = String(node.attrs?.path ?? '')
    const previewSrc = String(node.attrs?.previewSrc ?? '') || undefined
    if (id && path) {
      attachments.push({ id, path, ...(previewSrc ? { previewSrc } : {}) })
    }
  })
  return attachments
}

export function terminalRichInputApplyResourceContext(
  content: JSONContent,
  context: TerminalRichInputResourceContext
): JSONContent {
  return mapContent(content, (node) => {
    if (
      node.type !== TERMINAL_RICH_INPUT_FILE_MENTION_NODE &&
      node.type !== TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE
    ) {
      return node
    }
    return { ...node, attrs: { ...context, ...node.attrs } }
  })
}

export function terminalRichInputRemoveSubmittedContent(
  content: JSONContent,
  attachmentIds: readonly string[],
  removeText: boolean
): JSONContent {
  const removedIds = new Set(attachmentIds)
  if (removeText) {
    const remainingAttachments: JSONContent[] = []
    visitContent(content, (node) => {
      if (
        node.type === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE &&
        !removedIds.has(String(node.attrs?.id ?? ''))
      ) {
        remainingAttachments.push(node, {
          type: 'text',
          text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER
        })
      }
    })
    return { type: 'doc', content: [{ type: 'paragraph', content: remainingAttachments }] }
  }
  return removeTerminalRichInputImagesAndCaretSpacers(content, removedIds)
}

export function terminalRichInputPathsToContent(
  paths: string[],
  useMentions: boolean,
  context?: TerminalRichInputResourceContext,
  targetShell: TerminalTargetShell = 'posix'
): JSONContent[] {
  if (useMentions) {
    return paths.flatMap((path) => [
      {
        type: TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
        attrs: { path, ...context }
      },
      { type: 'text', text: ' ' }
    ])
  }
  return paths.map((path) => ({
    type: 'text',
    text: `${shellEscapePath(path, targetShell)} `
  }))
}

const FILE_REFERENCE_PATTERN = /(?<!\S)(?:@"((?:\\.|[^"])*)"|@(\S+))/g

export function terminalRichInputTextToContent(
  text: string,
  parseFileReferences = true,
  context?: TerminalRichInputResourceContext
): JSONContent {
  const content: JSONContent[] = []
  if (!parseFileReferences) {
    appendTextWithHardBreaks(content, text)
    return { type: 'doc', content: [{ type: 'paragraph', content }] }
  }
  let textStart = 0
  FILE_REFERENCE_PATTERN.lastIndex = 0
  let match = FILE_REFERENCE_PATTERN.exec(text)
  while (match) {
    appendTextWithHardBreaks(content, text.slice(textStart, match.index))
    content.push({
      type: TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
      attrs: {
        path: match[1] ? match[1].replace(/\\"/g, '"') : match[2],
        ...context
      }
    })
    textStart = match.index + match[0].length
    match = FILE_REFERENCE_PATTERN.exec(text)
  }
  appendTextWithHardBreaks(content, text.slice(textStart))
  return { type: 'doc', content: [{ type: 'paragraph', content }] }
}

export function terminalRichInputContentToClipboardText(doc: JSONContent): string {
  return terminalRichInputContentToText(doc, formatNativeChatFileReference)
}

export function terminalRichInputContentToText(
  doc: JSONContent,
  inlineImageText?: (imagePath: string) => string
): string {
  if (doc.type === 'doc') {
    return (doc.content ?? []).map((node) => serializeBlock(node, inlineImageText)).join('\n')
  }
  return serializeBlock(doc, inlineImageText)
}

function serializeBlock(
  node: JSONContent,
  inlineImageText?: (imagePath: string) => string
): string {
  if (node.type === 'text') {
    return (node.text ?? '').replaceAll(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER, '')
  }
  if (node.type === 'hardBreak') {
    return '\n'
  }
  if (node.type === TERMINAL_RICH_INPUT_FILE_MENTION_NODE) {
    return formatNativeChatFileReference(String(node.attrs?.path ?? ''))
  }
  if (node.type === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE) {
    return inlineImageText?.(String(node.attrs?.path ?? '')) ?? ''
  }
  return (node.content ?? []).map((child) => serializeBlock(child, inlineImageText)).join('')
}

function appendTextWithHardBreaks(content: JSONContent[], text: string): void {
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (line) {
      content.push({ type: 'text', text: line })
    }
    if (index < lines.length - 1) {
      content.push({ type: 'hardBreak' })
    }
  })
}

function visitContent(content: JSONContent, visit: (node: JSONContent) => void): void {
  visit(content)
  for (const child of content.content ?? []) {
    visitContent(child, visit)
  }
}

function removeTerminalRichInputImagesAndCaretSpacers(
  content: JSONContent,
  removedIds: ReadonlySet<string>
): JSONContent {
  if (!content.content) {
    return content
  }
  const remaining: JSONContent[] = []
  for (let index = 0; index < content.content.length; index += 1) {
    const child = content.content[index]
    if (
      child.type === TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE &&
      removedIds.has(String(child.attrs?.id ?? ''))
    ) {
      const next = content.content[index + 1]
      if (next?.type === 'text' && next.text?.startsWith(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)) {
        const remainingText = next.text.slice(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER.length)
        if (remainingText) {
          remaining.push({ ...next, text: remainingText })
        }
        index += 1
      }
      continue
    }
    remaining.push(removeTerminalRichInputImagesAndCaretSpacers(child, removedIds))
  }
  return { ...content, content: remaining }
}

function mapContent(
  content: JSONContent,
  mapNode: (node: JSONContent) => JSONContent | null
): JSONContent {
  return mapContentNode(content, mapNode) ?? { type: 'doc', content: [{ type: 'paragraph' }] }
}

function mapContentNode(
  content: JSONContent,
  mapNode: (node: JSONContent) => JSONContent | null
): JSONContent | null {
  const mapped = mapNode(content)
  if (!mapped) {
    return null
  }
  if (!mapped.content) {
    return mapped
  }
  return {
    ...mapped,
    content: mapped.content
      .map((child) => mapContentNode(child, mapNode))
      .filter((child): child is JSONContent => child !== null)
  }
}
