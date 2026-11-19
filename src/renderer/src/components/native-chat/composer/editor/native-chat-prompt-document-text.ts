import type { JSONContent } from '@tiptap/react'
import type { AgentJournalSkillRef } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentReferenceToken } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import {
  imageReferenceToken,
  splitImageReferences
} from '../../../../../../shared/native-chat/native-chat-image-reference'
import { NATIVE_CHAT_PASTED_TEXT_TOKEN } from '../../paste/native-chat-pasted-text-reference'

export const IMAGE_REFERENCE_NODE = 'nativeChatImageReference'
export const FILE_REFERENCE_NODE = 'nativeChatFileReference'

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
  return type === 'hardBreak' ? '\n' : (text ?? String(attrs?.token ?? ''))
}

export const QUOTE_NODE = 'nativeChatQuote'
// A line that Markdown reads as a blockquote line.
export const QUOTE_LINE = /^ {0,3}>/

function promptLineContent(line: string): JSONContent[] {
  return splitImageReferences(line).flatMap((part) =>
    typeof part === 'string'
      ? part
          .split(NATIVE_CHAT_PASTED_TEXT_TOKEN)
          .flatMap((piece, index): JSONContent[] =>
            piece === ''
              ? []
              : index % 2 === 1
                ? [{ type: FILE_REFERENCE_NODE, attrs: { token: piece, path: '' } }]
                : [{ type: 'text', text: piece }]
          )
      : [{ type: IMAGE_REFERENCE_NODE, attrs: { attachmentId: part.attachmentId } }]
  )
}

/**
 * All text-to-document paths must reconstruct image chips and pending-paste pills.
 * Quoted lines, a blank line and one more line become a quote chip, as "Add to chat" writes them.
 * The chip's text ends in that blank line; the next line goes on the chip's line, after it.
 * `literal` text (a paste) keeps its quoted lines as text.
 */
export function promptTextContent(text: string, options?: { literal?: boolean }): JSONContent {
  const lines = text.split('\n')
  const content: JSONContent[] = []
  let chips: JSONContent[] = []
  for (let index = 0; index < lines.length; index++) {
    let end = index
    while (!options?.literal && end < lines.length && QUOTE_LINE.test(lines[end])) {
      end++
    }
    if (end > index && lines[end] === '' && end + 1 < lines.length) {
      const token = `${lines.slice(index, end).join('\n')}\n\n`
      chips.push({ type: QUOTE_NODE, attrs: { token } })
      index = end
    } else {
      content.push({ type: 'paragraph', content: [...chips, ...promptLineContent(lines[index])] })
      chips = []
    }
  }
  return { type: 'doc', content }
}

// Holds the place of text with other pills: not a quote line and not blank.
const KEPT_LINE = 'x'

const tokenOf = (node: JSONContent): string => String(node.attrs?.token ?? '')

/** The text of text and quote chips; null when there are other nodes. */
function plainText(nodes: readonly JSONContent[]): string | null {
  let text = ''
  for (const node of nodes) {
    if (node.type === 'text') {
      text += node.text ?? ''
    } else if (node.type === QUOTE_NODE) {
      text += tokenOf(node)
    } else {
      return null
    }
  }
  return text
}

const blockKey = (block: JSONContent): string =>
  JSON.stringify((block.content ?? []).map((child) => [child.type, child.text, child.attrs]))

/**
 * The blocks with the quote chips that the parser reads from their text. The text stays the same.
 * Text with other pills stays as it is, after the chips that start its line.
 * Returns the changed blocks `first`..`last` and what replaces them, or null when nothing changes.
 */
export function reparseQuoteBlocks(
  blocks: readonly JSONContent[]
): { first: number; last: number; blocks: JSONContent[] } | null {
  // The content after its chips of each block with other pills, by the block's last line.
  const kept = new Map<number, JSONContent[]>()
  let line = -1
  const text = blocks
    .map((block) => {
      const content = block.content ?? []
      let chips = 0
      while (content[chips]?.type === QUOTE_NODE) {
        chips++
      }
      const rest = plainText(content.slice(chips))
      const blockText = content.slice(0, chips).map(tokenOf).join('') + (rest ?? KEPT_LINE)
      line += blockText.split('\n').length
      if (rest === null) {
        kept.set(line, content.slice(chips))
      }
      return blockText
    })
    .join('\n')
  line = -1
  const next = (promptTextContent(text).content ?? []).map((paragraph): JSONContent => {
    const chips = (paragraph.content ?? []).filter((node) => node.type === QUOTE_NODE)
    line += chips.reduce((lines, chip) => lines + tokenOf(chip).split('\n').length - 1, 1)
    const rest = kept.get(line)
    return rest ? { ...paragraph, content: [...chips, ...rest] } : paragraph
  })
  let first = 0
  while (
    first < blocks.length &&
    first < next.length &&
    blockKey(blocks[first]) === blockKey(next[first])
  ) {
    first++
  }
  let end = 0
  while (
    end < blocks.length - first &&
    end < next.length - first &&
    blockKey(blocks[blocks.length - 1 - end]) === blockKey(next[next.length - 1 - end])
  ) {
    end++
  }
  return first === blocks.length && first === next.length
    ? null
    : { first, last: blocks.length - 1 - end, blocks: next.slice(first, next.length - end) }
}

/** A stored document with the chips its text has. */
export function withQuoteChipsParsed(document: JSONContent): JSONContent {
  const content = document.content ?? []
  const result = reparseQuoteBlocks(content)
  return result
    ? {
        ...document,
        content: [
          ...content.slice(0, result.first),
          ...result.blocks,
          ...content.slice(result.last + 1)
        ]
      }
    : document
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
  attachmentId: string
): JSONContent {
  const isChip = (node: JSONContent | undefined): boolean =>
    node?.type === IMAGE_REFERENCE_NODE && node.attrs?.attachmentId === attachmentId
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

/**
 * Applies an appended text change without replacing existing picked nodes.
 * `literal` (a paste) keeps quoted lines as text, also in a draft that has no document yet.
 */
export function appendPromptDocumentText(
  document: JSONContent | undefined,
  before: string,
  after: string,
  options?: { literal?: boolean }
): JSONContent | undefined {
  const base = document ?? (options?.literal ? promptTextContent(before) : undefined)
  if (!base || before === after) {
    return document
  }
  const kept = before.trimEnd()
  if (kept === '') {
    return promptTextContent(after, options)
  }
  const blocks = [...(base.content ?? [])]
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
      } else if (node?.type === QUOTE_NODE) {
        // Trimmed as `kept` is, so the document text stays the draft text.
        const token = String(node.attrs?.token ?? '').trimEnd()
        content[content.length - 1] = { ...node, attrs: { ...node.attrs, token } }
        break
      } else {
        break
      }
    }
    if (content.length > 0 && block) {
      const [first, ...rest] = promptTextContent(after.slice(kept.length), options).content ?? []
      const joined = [
        ...blocks,
        { ...block, content: [...content, ...(first?.content ?? [])] },
        ...rest
      ]
      const document = { ...base, content: joined }
      // A paste stays literal; other text joins the quote runs it touches, as the sent text does.
      return options?.literal ? document : withQuoteChipsParsed(document)
    }
  }
  return promptTextContent(after, options)
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
