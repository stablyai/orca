import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Quote } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatPromptPill } from './NativeChatPromptPill'
import {
  quoteChipSpokenName,
  quotedText
} from '../../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

export function NativeChatQuotePill({ node, selected }: NodeViewProps): React.JSX.Element {
  const t = useTranslate()
  const text = quotedText(String(node.attrs.token))
  const label = text.replace(/\s+/g, ' ')
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <NativeChatPromptPill
        icon={Quote}
        label={label}
        spokenLabel={quoteChipSpokenName(
          t('components.native-chat.composer.quotePillLabel', 'Quote: {{text}}', { text: label })
        )}
        selected={selected}
        title={text}
        // As wide as the quote, to the line width; a long quote ends in an ellipsis. The margin
        // is the one space before the comment; the text has no space there.
        className="me-1 max-w-full"
      />
    </NodeViewWrapper>
  )
}
