import { createContext, useContext } from 'react'
import { Quote } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { quotedText } from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'
import { CommentMarkdownBlockLineContext } from '@/components/comment-markdown/comment-markdown-code-renderers'

type HastNode = {
  type: string
  value?: string
  children?: HastNode[]
  position?: { start: { line: number }; end: { line: number } }
}

/** The Markdown of the message that holds the sent quotes; null where no message gives it. */
export const NativeChatQuoteContentContext = createContext<string | null>(null)

/** The quote's lines in the message, without the `>` marks: the text "Add to chat" wrote. */
function quoteSourceText(
  content: string | null,
  blockLine: number,
  node?: HastNode
): string | null {
  const position = node?.position
  if (content === null || !position) {
    return null
  }
  const first = blockLine - 1 + position.start.line - 1
  const last = blockLine - 1 + position.end.line
  return quotedText(content.split('\n').slice(first, last).join('\n'))
}

function hastText(node: HastNode | undefined): string {
  return node?.type === 'text' ? (node.value ?? '') : (node?.children ?? []).map(hastText).join('')
}

/** A sent quote: a chip with the quote in its tooltip. */
export function NativeChatSentQuote({ node }: { node?: HastNode }): React.JSX.Element {
  const t = useTranslate()
  const text = hastText(node).trim()
  const label = text.replace(/\s+/g, ' ')
  const sourceText =
    quoteSourceText(
      useContext(NativeChatQuoteContentContext),
      useContext(CommentMarkdownBlockLineContext),
      node
    ) ?? text
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable, so the keyboard reaches the tooltip with the whole quote. */}
        <Badge
          variant="outline"
          tabIndex={0}
          // The end margin is the one space before the comment on its line.
          className="my-1 me-1 max-w-full align-middle"
          data-native-chat-sent-quote=""
        >
          <Quote aria-hidden="true" />
          <span className="sr-only">
            {t('components.native-chat.composer.quotePillLabel', 'Quote: {{text}}', {
              text: label
            })}
          </span>
          <span aria-hidden="true" className="truncate">
            {label}
          </span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap">{sourceText}</TooltipContent>
    </Tooltip>
  )
}
