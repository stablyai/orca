import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentJournalToolCallLifecycle } from '../../../../shared/agent-journal-tool-call-lifecycle'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock,
  type NativeChatToolCallBlock,
  type NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import {
  NativeChatCommandMetadata,
  NativeChatSearchResults,
  NativeChatToolName
} from './NativeChatToolAnnotations'
import { NativeChatToolIcon } from './NativeChatToolIcon'
import { NativeChatToolFileTarget } from './NativeChatToolFileTarget'
import { NativeChatDiffView } from './NativeChatDiffView'
import { NativeChatHighlightedCode } from './NativeChatHighlightedCode'
import { nativeChatToolLineLabel } from './native-chat-tool-line-label'
import { diffFromText, diffFromToolCall } from './native-chat-diff'
import { NativeChatExpandable } from './NativeChatExpandable'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { truncateToolDetail } from './native-chat-tool-summary'

const NO_SEARCH_RESULTS: NonNullable<NativeChatToolCallBlock['webSearchResults']> = []
const TARGET_CLASS =
  'min-w-0 truncate text-chat-foreground transition-colors group-hover/tool-line:text-chat-foreground-strong'

/** What an opened row shows. Its own component so a row diffs only while it is open. */
function ToolLineDetail({
  block,
  body,
  fullCommand,
  commandLanguage,
  results,
  onLinkClick
}: {
  block: NativeChatBlock
  body: NativeChatToolResultBlock | undefined
  fullCommand: string | null
  commandLanguage: string | null
  results: NonNullable<NativeChatToolCallBlock['webSearchResults']>
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  const diff = isToolCallBlock(block)
    ? diffFromToolCall(block.name, block.input)
    : isToolResultBlock(block)
      ? diffFromText(block.output)
      : null
  return (
    <div className="ml-6 space-y-1.5 py-1">
      {results.length > 0 ? (
        <NativeChatSearchResults results={results} onLinkClick={onLinkClick} />
      ) : null}
      {diff ? <NativeChatDiffView lines={diff} /> : null}
      {!diff && fullCommand ? (
        <pre
          data-native-chat-code-content
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-xs text-chat-foreground scrollbar-sleek"
        >
          {commandLanguage ? (
            <NativeChatHighlightedCode code={fullCommand} language={commandLanguage} />
          ) : (
            fullCommand
          )}
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
  )
}

/** A tool sentence with its output behind its own remembered disclosure. */
export function NativeChatToolLine({
  block,
  result,
  disclosureKey,
  onLinkClick
}: {
  block: NativeChatBlock
  /** This call's output, when the run paired one to it. Drawn here rather than
   *  as a `Result` row of its own, so an opened run lists the work, not twice
   *  as many rows half of which say `Result`. */
  result?: NativeChatToolResultBlock
  /** Identity this line's open state is remembered under while it is unmounted. */
  disclosureKey?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(disclosureKey, false)

  let name: string
  let resultPreview = ''
  const isCall = isToolCallBlock(block)
  const label = isCall ? nativeChatToolLineLabel(block, result) : null
  // A call opens to its output; its arguments are the row's own words, bar a shortened command.
  const fullCommand = label?.commandDetail ?? null

  if (isCall) {
    name = block.name
  } else if (isToolResultBlock(block)) {
    name = translate('components.native-chat.tool.result', 'Result')
    resultPreview = block.output.split('\n')[0]?.slice(0, 80) ?? ''
  } else {
    return null
  }
  const body = isCall ? result : block

  // A call the reader stopped was cut short, not failed.
  const lifecycle = isCall ? agentJournalToolCallLifecycle(block) : null
  const failed = lifecycle === 'failed' || (lifecycle !== 'interrupted' && result?.isError === true)
  const commandAlone = label?.command === true && label.verb !== null && label.target.length > 0
  const results = (isCall ? block.webSearchResults : undefined) ?? NO_SEARCH_RESULTS
  // An edit that has not landed has no output yet, but the change it proposes is worth opening.
  const proposesChange = () => isCall && diffFromToolCall(block.name, block.input) !== null
  const hasDetail =
    body !== undefined || fullCommand !== null || results.length > 0 || proposesChange()

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
            className={failed ? 'text-destructive/70' : 'text-chat-foreground-faint'}
          />
        ) : (
          /* A result's word is translated copy, not a tool name, so there is no
             category to read from it. The empty slot keeps rows aligned. */
          <span aria-hidden className="size-4 shrink-0" />
        )}
        {label?.verb && label.verb !== name ? <span className="sr-only">{name} </span> : null}
        {commandAlone ? (
          // The run's header already says these ran; the row is the command itself.
          <span className="sr-only">{label?.verb} </span>
        ) : (
          <span
            className={cn(
              'text-chat-foreground-faint transition-colors group-hover/tool-line:text-chat-foreground',
              label?.verb ? 'shrink-0' : 'min-w-0 truncate'
            )}
          >
            {label?.verb ??
              (isCall ? <NativeChatToolName name={name} mcpIdentity={block.mcpIdentity} /> : name)}
          </span>
        )}
        {label?.filePath ? (
          <NativeChatToolFileTarget
            path={label.filePath}
            label={label.target}
            className={TARGET_CLASS}
            onLinkClick={onLinkClick}
          />
        ) : (label?.target ?? resultPreview) ? (
          <span className={TARGET_CLASS} title={label?.title ?? resultPreview}>
            {label?.target ?? resultPreview}
          </span>
        ) : null}
        {/* Held at the row's right edge, so the carets of a run line up in one column. */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {isCall ? <NativeChatCommandMetadata block={block} /> : null}
          {hasDetail ? (
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-chat-foreground-faint transition-transform',
                expanded && 'rotate-90'
              )}
            />
          ) : null}
        </span>
      </button>
      {hasDetail ? (
        <NativeChatExpandable open={expanded}>
          <ToolLineDetail
            block={block}
            body={body}
            fullCommand={fullCommand}
            commandLanguage={label?.commandLanguage ?? null}
            results={results}
            onLinkClick={onLinkClick}
          />
        </NativeChatExpandable>
      ) : null}
    </div>
  )
}
