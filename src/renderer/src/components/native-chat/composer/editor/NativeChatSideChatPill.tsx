import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { GitFork } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPromptPill } from './NativeChatPromptPill'

export function NativeChatSideChatPill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  // The token's own trailing space separates the pill from the question.
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={GitFork}
        label={t('components.native-chat.sideChat.pill', 'Side chat')}
        selected={selected}
        data-native-chat-side-chat={String(node.attrs.token).trimEnd()}
        className="me-1"
      />
    </NodeViewWrapper>
  )
}
