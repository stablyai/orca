import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import {
  NativeChatCommandMetadata,
  NativeChatSearchResults,
  NativeChatToolName
} from './NativeChatToolAnnotations'
import { NativeChatToolIcon } from './NativeChatToolIcon'
import { NativeChatDiffView } from './NativeChatDiffView'
import { nativeChatToolLineLabel } from './native-chat-tool-line-label'
import { diffFromText, diffFromToolCall, type DiffLine } from './native-chat-diff'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import {
  createToolInputDisplay,
  truncateToolDetail
} from './native-chat-tool-summary'

/** A tool sentence with input and output behind its own remembered disclosure. */
export function NativeChatToolLine({
  block,
  result,
  initiallyExpanded = true,
  disclosureKey,
  onLinkClick
}: {
  block: NativeChatBlock
  /** This call's output, when the run paired one to it. Drawn here rather than
   *  as a `Result` row of its own, so an opened run lists the work, not twice
   *  as many rows half of which say `Result`. */
  result?: NativeChatToolResultBlock
  initiallyExpanded?: boolean
  /** Identity this line's open state is remembered under while it is unmounted. */
  disclosureKey?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(
    disclosureKey,
    initiallyExpanded
  )

  let name: string
  let preview: string
  let diff: DiffLine[] | null = null
  let body: { output: string; isError?: boolean } | null = null
  let detail: string | null = null
  let inputHasDetail = false
  const isCall = isToolCallBlock(block)
  const label = isCall ? nativeChatToolLineLabel(block, result) : null

  if (isCall) {
    name = block.name
    const inputDisplay = createToolInputDisplay(block.input)
    preview = inputDisplay.label
    inputHasDetail =
      label?.commandDetail !== undefined ? label.commandDetail !== null : inputDisplay.hasDetail
    diff = expanded ? diffFromToolCall(block.name, block.input) : null
    detail =
      expanded && !diff
        ? label?.commandDetail !== undefined
          ? label.commandDetail
          : inputDisplay.formatDetail()
        : null
    if (result) {
      body = { output: result.output, isError: result.isError }
    }
  } else if (isToolResultBlock(block)) {
    name = translate('components.native-chat.tool.result', 'Result')
    preview = block.output.split('\n')[0]?.slice(0, 80) ?? ''
    diff = expanded ? diffFromText(block.output) : null
    body = { output: block.output, isError: block.isError }
  } else {
    return null
  }

  const hasResults = isCall && (block.webSearchResults?.length ?? 0) > 0
  const hasDetail = diff !== null || body !== null || inputHasDetail || hasResults

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={cn(
          'group/tool-line flex min-h-[26px] w-full items-center gap-2 text-left font-sans text-[13px]',
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        )}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        {isCall ? (
          /* Decorative category glyph; the word beside it is the row's name. */
          <NativeChatToolIcon
            mcpIdentity={block.mcpIdentity}
            rowWord={name}
            className="text-chat-foreground-faint"
          />
        ) : (
          /* A result's word is translated copy, not a tool name, so there is no
             category to read from it. The empty slot keeps rows aligned. */
          <span aria-hidden className="size-4 shrink-0" />
        )}
        {label?.verb && label.verb !== name ? <span className="sr-only">{name} </span> : null}
        <span
          className={cn(
            'text-chat-foreground-faint transition-colors group-hover/tool-line:text-chat-foreground',
            label?.verb ? 'shrink-0' : 'min-w-0 truncate'
          )}
        >
          {label?.verb ??
            (isCall ? <NativeChatToolName name={name} mcpIdentity={block.mcpIdentity} /> : name)}
        </span>
        {(label?.target ?? preview) ? (
          <span
            className={cn(
              'min-w-0 truncate text-chat-foreground transition-colors group-hover/tool-line:text-chat-foreground-strong',
              label?.command &&
                'rounded-md border border-chat-inline-code-border bg-chat-inline-code-surface px-1.5 font-mono text-xs'
            )}
            data-native-chat-code-content={label?.command ? true : undefined}
            title={label?.title ?? preview}
            aria-hidden={label?.filePath ? true : undefined}
          >
            {label?.target ?? preview}
          </span>
        ) : null}
        {label?.filePath ? <span className="sr-only">{label.filePath}</span> : null}
        {isCall ? <NativeChatCommandMetadata block={block} /> : null}
        {hasDetail ? (
          // Hover reveal is keyed to this row's own named group: a bare `group`
          // also answers to the message row's, lighting every chevron at once.
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-chat-foreground-faint transition-all',
              expanded ? 'rotate-90 opacity-100' : 'opacity-0 group-hover/tool-line:opacity-100'
            )}
          />
        ) : null}
      </button>
      {hasDetail && expanded ? (
        <div className="ml-6 space-y-1.5 py-1">
          {isCall && hasResults ? (
            <NativeChatSearchResults results={block.webSearchResults} onLinkClick={onLinkClick} />
          ) : null}
          {diff ? <NativeChatDiffView lines={diff} /> : null}
          {!diff && detail ? (
            <pre
              data-native-chat-code-content
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-xs text-chat-foreground scrollbar-sleek"
            >
              {detail}
            </pre>
          ) : null}
          {body ? (
            <pre
              data-native-chat-code-content
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-xs scrollbar-sleek',
                body.isError ? 'text-destructive' : 'text-chat-foreground'
              )}
            >
              {truncateToolDetail(body.output)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
