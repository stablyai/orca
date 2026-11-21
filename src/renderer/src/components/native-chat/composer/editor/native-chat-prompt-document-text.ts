import type { JSONContent } from '@tiptap/react'
import type { AgentJournalSkillRef } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentReferenceToken } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import {
  imageReferenceToken,
  splitImageReferences
} from '../../../../../../shared/native-chat/attachments/native-chat-image-reference'
import { NATIVE_CHAT_PASTED_TEXT_TOKEN } from '../../paste/native-chat-pasted-text-reference'
import {
  botMentionToken,
  splitBotMentions
} from '../../../../../../shared/bots/bot-mention-context'

export const IMAGE_REFERENCE_NODE = 'nativeChatImageReference'
export const FILE_REFERENCE_NODE = 'nativeChatFileReference'
/** A bot, or one of its chats, picked under `@`: a pill that reads as its `[Bot: <name>](bot:<id>)`
 *  or `(bot-chat:<id>/<chatId>)` token. */
export const BOT_MENTION_NODE = 'nativeChatBotMention'

export function promptLeafString(
  type: string | undefined,
  attrs: Readonly<Record<string, unknown>> | undefined,
  text?: string | null
): string {
  if (type === 'nativeChatAgentReference') {
    return agentReferenceToken({
      label: String(attrs?.label),
      address: String(attrs?.address),
      hostKey: String(attrs?.hostKey)
    })
  }
  if (type === IMAGE_REFERENCE_NODE) {
    return imageReferenceToken(String(attrs?.attachmentId))
  }
  if (type === BOT_MENTION_NODE) {
    const chatId = typeof attrs?.chatId === 'string' && attrs.chatId ? attrs.chatId : undefined
    const server = typeof attrs?.server === 'string' && attrs.server ? attrs.server : undefined
    return botMentionToken({ id: String(attrs?.id), name: String(attrs?.name) }, chatId, server)
  }
  return type === 'hardBreak' ? '\n' : (text ?? String(attrs?.token ?? ''))
}

// A bot token in typed-over, pasted or restored text is the same mention picking puts there.
function botMentionContent(text: string): JSONContent[] {
  return splitBotMentions(text).map((part) =>
    typeof part === 'string'
      ? { type: 'text', text: part }
      : {
          type: BOT_MENTION_NODE,
          attrs: {
            id: part.id,
            name: part.name,
            chatId: part.chatId ?? '',
            server: part.server ?? ''
          }
        }
  )
}

/** Upgrade only paragraph text in an adopted draft; existing atoms and unknown blocks stay intact. */
export function restorePromptBotMentions(document: JSONContent): JSONContent {
  if (document.type !== 'doc' || !Array.isArray(document.content)) {
    return document
  }
  let changed = false
  const content = document.content.map((block) => {
    if (block?.type !== 'paragraph' || !Array.isArray(block.content)) {
      return block
    }
    let upgraded = false
    const content = block.content.flatMap((node) => {
      if (node?.type !== 'text' || typeof node.text !== 'string' || !node.text) {
        return [node]
      }
      const parts = botMentionContent(node.text)
      if (!parts.some((part) => part.type === BOT_MENTION_NODE)) {
        return [node]
      }
      upgraded = true
      return parts.map((part) =>
        part.type === 'text' ? { ...node, text: part.text } : { ...part, marks: node.marks }
      )
    })
    changed ||= upgraded
    return upgraded ? { ...block, content } : block
  })
  return changed ? { ...document, content } : document
}

/** The editor's opening content: an adopted draft's document with bot pills restored, else its text. */
export function openingPromptContent(
  document: JSONContent | undefined,
  text: string,
  imageChips = false
): JSONContent {
  return document
    ? restorePromptBotMentions(
        promptParagraphLines(imageChips ? document : withoutImageReferenceNodes(document))
      )
    : promptTextContent(text, imageChips)
}

/** Image tokens become chips only for an editor that holds them; otherwise they stay literal text. */
export function promptTextContent(text: string, imageChips = false): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => {
      const parts: ReturnType<typeof splitImageReferences> = imageChips
        ? splitImageReferences(line)
        : [line]
      return {
        type: 'paragraph',
        content: parts.flatMap((part) =>
          typeof part === 'string'
            ? part
                .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
                .flatMap((piece, index): JSONContent[] =>
                  piece === ''
                    ? []
                    : index % 2 === 1
                      ? [{ type: FILE_REFERENCE_NODE, attrs: { token: piece, path: '' } }]
                      : botMentionContent(piece)
                )
            : [{ type: IMAGE_REFERENCE_NODE, attrs: { attachmentId: part.attachmentId } }]
        )
      }
    })
  }
}

/** Drafts saved before Shift+Enter split paragraphs hold hard breaks; initial editor content skips the hard-break plugin, which only sees transactions. */
export function promptParagraphLines(document: JSONContent): JSONContent {
  return {
    ...document,
    content: document.content?.flatMap((block) => {
      const lines: JSONContent[][] = [[]]
      for (const node of block.content ?? []) {
        if (node.type === 'hardBreak') {
          lines.push([])
        } else {
          lines.at(-1)?.push(node)
        }
      }
      return lines.length === 1 ? [block] : lines.map((content) => ({ ...block, content }))
    })
  }
}

export function seedPromptSkillReferences(
  node: JSONContent,
  skills: readonly AgentJournalSkillRef[] = [],
  occurrences = new Map<string, number>()
): JSONContent {
  if ((node.type === 'text' && node.text) || skills.length === 0) {
    return node
  }
  return {
    ...node,
    content: node.content?.flatMap((child) => {
      if (child.type !== 'text' || !child.text) {
        return [seedPromptSkillReferences(child, skills, occurrences)]
      }
      const pieces: JSONContent[] = []
      const text = child.text
      let start = 0
      const names = [...new Set(skills.map(({ name }) => name))]
        .sort((a, b) => b.length - a.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = new RegExp(`[$/](?:${names.join('|')})(?![\\w:-])`, 'gu')
      for (const match of text.matchAll(pattern)) {
        if (match[0].startsWith('/') && match.index > 0 && !/\s/u.test(text[match.index - 1])) {
          continue
        }
        const name = match[0].slice(1)
        const matching = skills.filter((skill) => skill.name === name)
        const occurrence = occurrences.get(name) ?? 0
        const skill = matching[occurrence] ?? matching[0]
        occurrences.set(name, occurrence + 1)
        if (!skill) {
          continue
        }
        if (match.index > start) {
          pieces.push({ type: 'text', text: text.slice(start, match.index) })
        }
        pieces.push({ type: 'nativeChatSkill', attrs: { token: match[0], path: skill.path } })
        start = match.index + match[0].length
      }
      if (start < text.length) {
        pieces.push({ type: 'text', text: text.slice(start) })
      }
      return pieces
    })
  }
}

/** The document side of withoutImageReference: each chip goes with one space after it. */
export function withoutImageReferenceNodes(
  document: JSONContent,
  attachmentId?: string
): JSONContent {
  const isChip = (node: JSONContent | undefined): boolean =>
    node?.type === IMAGE_REFERENCE_NODE &&
    (attachmentId === undefined || node.attrs?.attachmentId === attachmentId)
  return document.content
    ? {
        ...document,
        content: document.content.flatMap((node, index, nodes) => {
          if (isChip(node)) {
            return []
          }
          if (isChip(nodes[index - 1]) && node.type === 'text' && node.text?.startsWith(' ')) {
            const text = node.text.slice(1)
            return text ? [{ ...node, text }] : []
          }
          return [withoutImageReferenceNodes(node, attachmentId)]
        })
      }
    : document
}

/** Applies an appended text change without replacing existing picked nodes. */
export function appendPromptDocumentText(
  document: JSONContent | undefined,
  before: string,
  after: string
): JSONContent | undefined {
  if (!document || before === after) {
    return document
  }
  const kept = before.trimEnd()
  if (kept === '') {
    return promptTextContent(after)
  }
  const blocks = [...(document.content ?? [])]
  while (blocks.length > 0) {
    const block = blocks.pop()
    const content = [...(block?.content ?? [])]
    while (content.length > 0) {
      const node = content.at(-1)
      if (node?.type === 'hardBreak') {
        content.pop()
      } else if (node?.type === 'text') {
        const text = node.text?.trimEnd() ?? ''
        if (text === '') {
          content.pop()
        } else {
          content[content.length - 1] = { ...node, text }
          break
        }
      } else {
        break
      }
    }
    if (content.length > 0 && block) {
      const [first, ...rest] = promptTextContent(after.slice(kept.length)).content ?? []
      return {
        ...document,
        content: [
          ...blocks,
          { ...block, content: [...content, ...(first?.content ?? [])] },
          ...rest
        ]
      }
    }
  }
  return promptTextContent(after)
}

/** Slice serialized prompt offsets while retaining selected nodes inside the range. */
export function slicePromptDocument(document: JSONContent, from: number, to: number): JSONContent {
  let offset = 0
  const blocks: JSONContent[] = []
  for (const [index, block] of (document.content ?? []).entries()) {
    if (index > 0) {
      offset++
    }
    const start = offset
    const content: JSONContent[] = []
    for (const node of block.content ?? []) {
      const value = promptLeafString(node.type, node.attrs, node.text)
      const end = offset + value.length
      if (end > from && offset < to) {
        content.push(
          node.type === 'text'
            ? {
                ...node,
                text: value.slice(Math.max(0, from - offset), Math.min(value.length, to - offset))
              }
            : node
        )
      }
      offset = end
    }
    if (offset >= from && start <= to) {
      blocks.push({ ...block, content })
    }
  }
  return { ...document, content: blocks.length ? blocks : [{ type: 'paragraph' }] }
}
