import { createContext, useContext } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { GitFork } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPromptPill } from './NativeChatPromptPill'

/** False where this chat cannot open side chats: a stored pill then reads as the text it sends. */
export const NativeChatSideChatAvailable = createContext(false)

export function NativeChatSideChatPill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const available = useContext(NativeChatSideChatAvailable)
  const token = String(node.attrs.token)
  // The token's own trailing space separates the pill from the question.
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      {available ? (
        <NativeChatPromptPill
          icon={GitFork}
          label={t('components.native-chat.sideChat.pill', 'Side chat')}
          selected={selected}
          data-native-chat-side-chat={token.trimEnd()}
          className="me-1"
        />
      ) : (
        <span className="whitespace-pre">{token}</span>
      )}
    </NodeViewWrapper>
  )
}
