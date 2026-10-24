import type { JSONContent } from '@tiptap/react'
import { composerSkillOccurrences } from '../../../../shared/structured-agent-session-send-mutation'
import { promptTextContent, promptDocumentLeafText } from './native-chat-prompt-document-text'
import type { NativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { promptMarkersToImageReferences } from '../../../../shared/native-chat-image-transcript-markers'

/** The text a message body carries, as the composer shows it. */
export function structuredAgentSessionMessageText(body: AgentJournalMessageItem): string {
  return body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

/** Puts a message's text and images into a composer, after whatever is there. True once the text
 *  is durable. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks'],
  /** Each image's SSH connection, in block order. */
  imageConnectionIds?: readonly (string | null)[],
  options?: {
    skills?: readonly { name: string; path: string }[]
    textPolicy?: 'append-repeated'
    acknowledge?: (saved: Promise<boolean>) => void
  }
): boolean {
  // Its `[Image #k]` markers become chips for its k-th image, by the ids its images get below.
  const imageIds = blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [`${attachmentIdPrefix}-${index}`] : []
  )
  let image = 0
  // Not the attachment hook's helper: its imports reach the store, whose teardown imports this.
  const images = blocks.flatMap((block, index) => {
    if (block.type !== 'image-ref') {
      return []
    }
    const connectionId = imageConnectionIds?.[image++]
    const { type: _type, ...reference } = block
    return [
      {
        id: `${attachmentIdPrefix}-${index}`,
        path: block.path ?? '',
        reference,
        ...(connectionId ? { connectionId } : {})
      }
    ]
  })
  // One step, so a crash never leaves chips without their images, and a second return of the
  // message is skipped by its image ids whatever was typed since.
  const text = promptMarkersToImageReferences(
    structuredAgentSessionMessageText({ kind: 'message', role: 'user', blocks }),
    imageIds
  )
  const document = options?.skills?.length ? promptTextContent(text) : undefined
  const bindings = composerSkillOccurrences(text, options?.skills ?? [])
  let offset = 0
  for (const paragraph of document?.content ?? []) {
    paragraph.content = paragraph.content?.flatMap((node) => {
      if (node.type !== 'text' || !node.text) {
        offset += promptDocumentLeafText(node.type, node.attrs).length
        return [node]
      }
      const start = offset
      offset += node.text.length
      const parts: JSONContent[] = []
      let from = 0
      for (const { ref, at: position } of bindings) {
        if (position < start || position >= offset) {
          continue
        }
        const at = position - start
        if (at > from) {
          parts.push({ type: 'text', text: node.text.slice(from, at) })
        }
        parts.push({
          type: 'nativeChatSkill',
          attrs: { token: `$${ref.name}`, path: ref.path }
        })
        from = at + ref.name.length + 1
      }
      if (from < node.text.length) {
        parts.push({ type: 'text', text: node.text.slice(from) })
      }
      return parts
    })
    offset += 1
  }
  const addition: Pick<NativeChatComposerDraftAddition, 'document' | 'textPolicy'> = {
    ...(document ? { document } : {}),
    ...(options?.textPolicy ? { textPolicy: options.textPolicy } : {})
  }
  return appendNativeChatDraftCache(composerScopeKey, text, undefined, images, {
    ...addition,
    acknowledge: options?.acknowledge
  })
}

/**
 * Puts a message that did not reach the host back in its chat's composer, after whatever is
 * there: the chat's draft is keyed by its conversation, so this works with or without its view
 * mounted. True once the text is durable.
 */
export function handBackStructuredAgentSessionMessage(
  sessionId: string,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  imageConnectionIds?: readonly (string | null)[]
): boolean {
  return returnMessageToComposer(
    structuredAgentSessionDraftScopeKey(sessionId),
    `returned-${clientMessageId}`,
    body.blocks,
    imageConnectionIds,
    { skills: body.skills }
  )
}
