import { createContext, useContext } from 'react'
import { Quote } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { openDetectedFilePath } from '@/components/terminal-pane/links/files/terminal-file-open-routing'
import { openLinkedFileInEditor } from '@/components/terminal-pane/links/files/terminal-file-link-editor-open'
import { isHtmlFilePath } from '@/components/terminal-pane/links/files/local-html-file-destinations'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
import { relativePathInsideRoot } from '../../../../../shared/file-access/cross-platform-path'
import type { NativeChatFileLinkContext } from '../links/actions/native-chat-file-link-context'
import { resolveNativeChatFileLink } from '../links/actions/native-chat-file-link'
import { nativeChatFileOpenDeps } from '../links/actions/native-chat-link-target-actions'
import { NativeChatMarkdownImageOwnerContext } from '../media/images/native-chat-markdown-image-owner'
import { jumpToQuoteSource, type QuotedFileLocation } from './native-chat-quote-sources'
import { NativeChatQuoteJumpContext } from './use-native-chat-quote-jump'
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

function openQuotedFile(
  location: QuotedFileLocation,
  context: NativeChatFileLinkContext | null
): boolean {
  const target = resolveNativeChatFileLink(`${location.pathText}:${location.line}`, context)
  if (!context || !target) {
    return false
  }
  const line = target.line ?? location.line
  // An HTML file opens as a page, which has no lines: a quote of its source opens the editor.
  const relativePath = relativePathInsideRoot(context.worktreePath, target.absolutePath)
  if (isHtmlFilePath(target.absolutePath) && relativePath) {
    openLinkedFileInEditor(
      {
        filePath: target.absolutePath,
        relativePath,
        worktreeId: context.worktreeId,
        runtimeEnvironmentId: context.runtimeEnvironmentId
      },
      null,
      { line, column: 1, length: Number.MAX_SAFE_INTEGER },
      beginLinkOpenRequest()
    )
    return true
  }
  openDetectedFilePath(target.absolutePath, line, 1, {
    ...nativeChatFileOpenDeps(target, context),
    // The reveal stops at the line end, so this highlights the first quoted line.
    revealLength: Number.MAX_SAFE_INTEGER
  })
  return true
}

/** A sent quote: a chip that goes back to where the quote came from. */
export function NativeChatSentQuote({ node }: { node?: HastNode }): React.JSX.Element {
  const t = useTranslate()
  const jumpToMessage = useContext(NativeChatQuoteJumpContext)
  const fileLinkContext = useContext(NativeChatMarkdownImageOwnerContext)?.fileLinkContext ?? null
  const text = hastText(node).trim()
  const sourceText =
    quoteSourceText(
      useContext(NativeChatQuoteContentContext),
      useContext(CommentMarkdownBlockLineContext),
      node
    ) ?? text
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          // The end margin is the one space before the comment on its line.
          className="my-1 me-1 max-w-full"
          onClick={() =>
            jumpToQuoteSource(sourceText, {
              jumpToMessage,
              openFile: (location) => openQuotedFile(location, fileLinkContext),
              notifyMissing: () =>
                toast(
                  t(
                    'components.native-chat.quoteSourceMissing',
                    'The source of this quote is not available.'
                  )
                )
            })
          }
          data-native-chat-sent-quote=""
        >
          <Quote aria-hidden="true" />
          <span className="sr-only">{t('components.native-chat.quoteChip', 'Quote')}: </span>
          <span className="truncate">{text.replace(/\s+/g, ' ')}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-md whitespace-pre-wrap">{sourceText}</TooltipContent>
    </Tooltip>
  )
}
