import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { useMemo } from 'react'
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
import { NativeChatToolFileTarget } from './NativeChatToolFileTarget'
import { NativeChatDiffView } from './NativeChatDiffView'
import { NativeChatHighlightedCode } from './NativeChatHighlightedCode'
import { nativeChatToolRowVerb } from './native-chat-tool-line-label'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../shared/native-chat/tools/native-chat-tool-activity'
import { nativeChatToolLineView } from '../../../../shared/native-chat/tools/native-chat-tool-line-view'
import type { NativeChatWebSearchResult } from '../../../../shared/native-chat/tools/native-chat-tool-identity'
import {
  diffFromText,
  diffFromToolCall
} from '../../../../shared/native-chat/tools/native-chat-diff'
import { NativeChatExpandable } from './NativeChatExpandable'
import { useNativeChatDisclosure } from './native-chat-disclosure-store'
import { NativeChatToolOutput } from './NativeChatToolOutput'

const TARGET_CLASS =
  'min-w-0 truncate text-chat-foreground transition-colors group-hover/tool-line:text-chat-foreground-strong'

/** Mount detail separately so collapsed rows do no diff work. */
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
  results: NativeChatWebSearchResult[]
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
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-chat-code text-chat-foreground scrollbar-sleek"
        >
          {commandLanguage ? (
            <NativeChatHighlightedCode code={fullCommand} language={commandLanguage} />
          ) : (
            fullCommand
          )}
        </pre>
      ) : null}
      {body ? <NativeChatToolOutput body={body} /> : null}
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
  /** Pair output with its call instead of adding a separate Result row. */
  result?: NativeChatToolResultBlock
  /** Identity this line's open state is remembered under while it is unmounted. */
  disclosureKey?: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  const { open: expanded, setOpen: setExpanded } = useNativeChatDisclosure(disclosureKey, false)

  const view = useMemo(
    () =>
      isToolCallBlock(block) || isToolResultBlock(block)
        ? nativeChatToolLineView(block, result)
        : null,
    [block, result]
  )
  const isCall = isToolCallBlock(block)
  if (!view) {
    return null
  }
  const name = isCall
    ? block.name
    : translate('components.native-chat.tool.result', NATIVE_CHAT_TOOL_ACTIVITY_COPY.result)
  const { label: sharedLabel, body, resultPreview, failed, results, hasDetail } = view
  const label = sharedLabel && {
    ...sharedLabel,
    verb: sharedLabel.verb === null ? null : nativeChatToolRowVerb(sharedLabel.verb)
  }
  // A call opens to its output; its arguments are the row's own words, bar a shortened command.
  const fullCommand = label?.commandDetail ?? null
  const commandAlone = label?.command === true && label.verb !== null && label.target.length > 0

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(!expanded)}
        className={cn(
          'group/tool-line flex min-h-6.5 w-full items-center gap-2 rounded-md text-left font-sans text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        )}
        aria-expanded={hasDetail ? expanded : undefined}
      >
        {isCall ? (
          <NativeChatToolIcon
            mcpIdentity={block.mcpIdentity}
            rowWord={name}
            input={block.input}
            className={failed ? 'text-destructive/70' : 'text-chat-foreground-faint'}
          />
        ) : (
          /* Translated result labels identify no tool category; reserve an empty slot for alignment. */
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
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
          {isCall ? <NativeChatCommandMetadata block={block} /> : null}
          {hasDetail ? (
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-chat-foreground-faint transition-transform motion-reduce:transition-none',
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
