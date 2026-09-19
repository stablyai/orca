import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock
} from '../../../../shared/native-chat-types'
import {
  NativeChatCommandMetadata,
  NativeChatSearchResults,
  NativeChatToolName
} from './NativeChatToolAnnotations'
import { NativeChatToolIcon } from './NativeChatToolIcon'
import { NativeChatDiffView } from './NativeChatDiffView'
import { diffFromText, diffFromToolCall, type DiffLine } from './native-chat-diff'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { createToolInputDisplay, truncateToolDetail } from './native-chat-tool-summary'

/** A single inline tool line — `▸ ToolName  preview` — that expands in place to
 *  show the call's diff/input or the result's body. Tool calls read as flat
 *  lines in the conversation rather than boxed blocks (mobile parity). Lines only
 *  mount while the parent run is open and are individually collapsible. */
export function NativeChatToolLine({
  block,
  initiallyExpanded = true,
  disclosureKey,
  onLinkClick
}: {
  block: NativeChatBlock
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

  if (isCall) {
    name = block.name
    const inputDisplay = createToolInputDisplay(block.input)
    preview = inputDisplay.label
    inputHasDetail = inputDisplay.hasDetail
    diff = expanded ? diffFromToolCall(block.name, block.input) : null
    detail = expanded && !diff ? inputDisplay.formatDetail() : null
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
          'group flex w-full items-center gap-1.5 py-0.5 text-left',
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        )}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        {isCall ? (
          /* Decorative category glyph; the word beside it is the row's name. */
          <NativeChatToolIcon
            mcpIdentity={block.mcpIdentity}
            rowWord={name}
            className="text-muted-foreground"
          />
        ) : (
          /* A result's word is translated copy, not a tool name, so there is no
             category to read from it. The empty slot keeps rows aligned. */
          <span aria-hidden className="size-4 shrink-0" />
        )}
        <code className="min-w-0 truncate font-mono text-xs font-semibold text-foreground/90 transition-colors group-hover:text-foreground">
          {isCall ? <NativeChatToolName name={name} mcpIdentity={block.mcpIdentity} /> : name}
        </code>
        {preview ? (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/70"
            title={preview}
          >
            {preview}
          </span>
        ) : null}
        {isCall ? <NativeChatCommandMetadata block={block} /> : null}
        {hasDetail ? (
          // Chevron stays hidden until this row is expanded.
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-all',
              expanded ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          />
        ) : null}
      </button>
      {hasDetail && expanded ? (
        <div className="space-y-1.5 py-1">
          {isCall && hasResults ? (
            <NativeChatSearchResults results={block.webSearchResults} onLinkClick={onLinkClick} />
          ) : null}
          {diff ? <NativeChatDiffView lines={diff} /> : null}
          {!diff && body ? (
            <pre
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] scrollbar-sleek',
                body.isError ? 'text-destructive' : 'text-foreground/80'
              )}
            >
              {truncateToolDetail(body.output)}
            </pre>
          ) : null}
          {!diff && !body && detail ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] text-foreground/80 scrollbar-sleek">
              {detail}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
