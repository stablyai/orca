import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Quote } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import { quotedText } from '../../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

export function NativeChatQuotePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const text = quotedText(String(node.attrs.token))
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <span className="sr-only">{t('components.native-chat.quoteChip', 'Quote')}: </span>
      <NativeChatPromptPill
        icon={Quote}
        label={text.replace(/\s+/g, ' ')}
        selected={selected}
        title={text}
        // As wide as the quote, to a fixed limit; a long quote ends in an ellipsis. The margin
        // is the one space before the comment; the text has no space there.
        className="me-1 max-w-[min(100%,24rem)]"
      />
    </NodeViewWrapper>
  )
}
