import type { OrchestrationAgentReference } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { NativeChatFileReferencePill } from './NativeChatFileReferencePill'
import { NativeChatSkillPill, skillLabel } from './NativeChatSkillPill'
import { NativeChatImageReferencePill } from './NativeChatImageReferencePill'
import { NativeChatBotMentionPill } from './NativeChatBotMentionPill'
import { NativeChatPromptPillKeys } from './native-chat-prompt-pill-keys'
import { formatNativeChatFileReference } from '../../../../../../shared/native-chat/input/composer/agent-image-paste'
import { imageReferenceToken } from '../../../../../../shared/native-chat/attachments/native-chat-image-reference'
import {
  BOT_MENTION_NODE,
  FILE_REFERENCE_NODE,
  IMAGE_REFERENCE_NODE,
  promptLeafString,
  promptTextContent
} from './native-chat-prompt-document-text'
import { ReactNodeViewRenderer, Node, type Editor, type JSONContent } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { AgentJournalSkillRef } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionInteractionCommand } from '../../../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'

export const NativeChatSkill = Node.create({
  name: 'nativeChatSkill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatSkillPill),
  // `path`: the file the agent selects the skill by, when it reported one; the text stays the token.
  addAttributes: () => ({ token: { default: '' }, path: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => [
    'span',
    {
      'data-native-chat-skill': node.attrs.token,
      contenteditable: 'false',
      class:
        'inline-flex items-center gap-1 rounded-full border border-border bg-muted px-1.5 text-xs font-medium text-muted-foreground align-baseline select-none'
    },
    ['span', { 'aria-hidden': 'true' }, 'ϟ'],
    ['span', {}, skillLabel(String(node.attrs.token))]
  ]
})

/** A file attached by path. `token` is the reference the agent reads; the pill shows the filename. */
export const NativeChatFileReference = Node.create({
  name: FILE_REFERENCE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatFileReferencePill),
  addAttributes: () => ({ token: { default: '' }, path: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  renderHTML: ({ node }) => ['span', { 'data-native-chat-file-reference': node.attrs.path }]
})

export const NativeChatImageReference = Node.create({
  name: IMAGE_REFERENCE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatImageReferencePill),
  addAttributes: () => ({ attachmentId: { default: '' } }),
  renderText: ({ node }) => imageReferenceToken(node.attrs.attachmentId),
  renderHTML: ({ node }) => [
    'span',
    { 'data-native-chat-image-reference': node.attrs.attachmentId }
  ]
})

/** A bot picked under `@`: the pill shows it; the text stays its `[Bot: <name>](bot:<id>)` token. */
export const NativeChatBotMention = Node.create({
  name: BOT_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => ReactNodeViewRenderer(NativeChatBotMentionPill),
  // `chatId`: one of the bot's chats, picked in its list; empty for the bot alone (its Home Chat).
  // `server`: the paired server a bot on another computer runs on; empty for the chat's own host.
  addAttributes: () => ({
    id: { default: '' },
    name: { default: '' },
    chatId: { default: '' },
    server: { default: '' }
  }),
  renderText: ({ node }) => promptLeafString(BOT_MENTION_NODE, node.attrs),
  renderHTML: ({ node }) => [
    'span',
    { 'data-native-chat-bot-mention': node.attrs.id },
    promptLeafString(BOT_MENTION_NODE, node.attrs)
  ]
})

/** The composer's pill nodes, with the keys that delete and step over them in one press. */
export const nativeChatPromptPills = [
  NativeChatSkill,
  NativeChatFileReference,
  NativeChatImageReference,
  NativeChatBotMention,
  NativeChatPromptPillKeys
]

/** Replaces text offsets `from`..`to` with a picked mention's token and a space; a bot's token
 *  becomes its pill. Its own undo step, as a picked skill is: undo gives back the typed `@query`. */
export function insertPromptMention(
  editor: Editor,
  from: number,
  to: number,
  token: string,
  agent?: OrchestrationAgentReference
): void {
  // Mid-IME the composition owns the field: editing under it garbles the composed text. The
  // composer drops a pick made then, as it always has (its own write also defers to the IME).
  if (editor.view.composing) {
    return
  }
  const { doc } = editor.state
  const range = { from: promptTextPosition(doc, from), to: promptTextPosition(doc, to) }
  const [line] = promptTextContent(`${token} `).content ?? []
  const content = agent
    ? [
        {
          type: 'nativeChatAgentReference',
          attrs: {
            label: agent.label,
            address: agent.address,
            hostKey: agent.hostKey,
            kind: agent.kind ?? '',
            session: agent.session ?? '',
            agentType: agent.agentType ?? ''
          }
        },
        { type: 'text', text: ' ' }
      ]
    : (line?.content ?? [])
  editor.view.dispatch(closeHistory(editor.state.tr))
  editor.chain().insertContentAt(range, content).run()
  editor.view.dispatch(closeHistory(editor.state.tr))
}

export function promptSkillRefs(document: JSONContent | undefined): AgentJournalSkillRef[] {
  if (!document) {
    return []
  }
  const token = document.attrs?.token
  const path = document.attrs?.path
  const own =
    document.type === NativeChatSkill.name &&
    typeof token === 'string' &&
    typeof path === 'string' &&
    token.length > 1 &&
    path.length > 0
      ? [{ name: token.slice(1), path }]
      : []
  return [...own, ...(document.content ?? []).flatMap((child) => promptSkillRefs(child))]
}

/** Files or images attached inline as pills. */
export function promptHasAttachmentReferences(document: JSONContent | undefined): boolean {
  return (
    document !== undefined &&
    (document.type === NativeChatFileReference.name ||
      document.type === NativeChatImageReference.name ||
      (document.content ?? []).some(promptHasAttachmentReferences))
  )
}

export function promptHasInteractionModeSkill(
  agent: string,
  text: string,
  document: JSONContent | undefined
): boolean {
  return (
    agentSessionInteractionCommand(agent, text) !== null &&
    promptSkillRefs(document).some((skill) => text.trimEnd() === `/${skill.name}`)
  )
}

export function fileReferenceContent(path: string): JSONContent {
  return {
    type: NativeChatFileReference.name,
    attrs: { token: formatNativeChatFileReference(path), path }
  }
}

/** A pill reads as its token and a hard break as a newline, so the text is what the agent receives. */
export function promptLeafText(node: ProseMirrorNode): string {
  return promptLeafString(node.type.name, node.attrs, node.text)
}

export function promptText(doc: ProseMirrorNode, from = 0, to = doc.content.size): string {
  return doc.textBetween(from, to, '\n', promptLeafText)
}

export function promptTextOffset(doc: ProseMirrorNode, position: number): number {
  const resolved = doc.resolve(position)
  // Paragraph node selections start outside the block; include its preceding newline.
  const to = resolved.parent === doc && resolved.nodeAfter?.isTextblock ? position + 1 : position
  return promptText(doc, 0, to).length
}

/** Map carets inside pill tokens to the chosen edge; clamp offsets beyond the document end. */
export function promptTextPosition(
  doc: ProseMirrorNode,
  offset: number,
  side: 'before' | 'after' = 'before'
): number {
  let remaining = offset
  let blockStart = 0
  let end = 1
  for (let index = 0; index < doc.childCount; index++) {
    const block = doc.child(index)
    if (index > 0) {
      if (remaining === 0) {
        return end
      }
      remaining--
    }
    let start = blockStart + 1
    for (let child = 0; child < block.childCount; child++) {
      if (remaining === 0) {
        return start
      }
      const node = block.child(child)
      const length = (node.text ?? promptLeafText(node)).length
      if (remaining < length) {
        return node.isText ? start + remaining : side === 'before' ? start : start + node.nodeSize
      }
      remaining -= length
      start += node.nodeSize
    }
    end = start
    blockStart += block.nodeSize
  }
  return end
}
