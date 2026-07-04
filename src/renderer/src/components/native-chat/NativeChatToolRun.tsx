import { useEffect, useState } from 'react'
import { AlertCircle, ChevronDown, SquareChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock
} from '../../../../shared/native-chat-types'
import { diffFromText, diffFromToolCall, type DiffLine } from './native-chat-diff'
import { countToolCalls, summarizeToolInput, summarizeToolRun } from './native-chat-tool-summary'
import { NativeChatDiffView } from './NativeChatDiffView'

const MAX_TOOL_RESULT_CHARS = 4000

/** A single inline tool line — `▸ ToolName  preview` — that expands in place to
 *  show the call's diff/input or the result's body. Tool calls read as flat
 *  lines in the conversation rather than boxed blocks (mobile parity). */
function ToolLine({ block }: { block: NativeChatBlock }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  let name: string
  let preview: string
  let diff: DiffLine[] | null = null
  let body: { output: string; isError?: boolean } | null = null

  if (isToolCallBlock(block)) {
    name = block.name
    preview = summarizeToolInput(block.input)
    diff = diffFromToolCall(block.name, block.input)
  } else if (isToolResultBlock(block)) {
    name = translate('components.native-chat.tool.result', 'Result')
    preview = block.output.split('\n')[0]?.slice(0, 80) ?? ''
    diff = diffFromText(block.output)
    body = { output: block.output, isError: block.isError }
  } else {
    return null
  }

  const hasDetail = diff !== null || body !== null || preview.length > 40

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        aria-expanded={hasDetail ? expanded : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          hasDetail
            ? 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
            : 'cursor-default'
        )}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <SquareChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <code className="shrink-0 font-mono text-xs font-semibold text-foreground/90">{name}</code>
        {preview ? (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
            title={preview}
          >
            {preview}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <div className="space-y-1.5 py-1 pl-5">
          {diff ? <NativeChatDiffView lines={diff} /> : null}
          {!diff && body ? (
            <pre
              className={cn(
                'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] scrollbar-sleek',
                body.isError ? 'text-destructive' : 'text-foreground/80'
              )}
            >
              {body.output.length > MAX_TOOL_RESULT_CHARS
                ? `${body.output.slice(0, MAX_TOOL_RESULT_CHARS)}…`
                : body.output}
            </pre>
          ) : null}
          {!diff && !body && preview ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] text-foreground/80 scrollbar-sleek">
              {preview}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A run of a message's tool calls/results, collapsed to a one-line summary that
 *  expands to the individual inline tool lines. `expandSignal` lets the global
 *  toolbar toggle drive every run at once while still allowing per-run override. */
export function NativeChatToolRun({
  blocks,
  expandSignal
}: {
  blocks: NativeChatBlock[]
  /** Toolbar-driven desired open state. Each change re-syncs this run's state. */
  expandSignal: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(expandSignal)
  // Re-sync when the global toolbar toggle flips.
  useEffect(() => setOpen(expandSignal), [expandSignal])

  const callCount = countToolCalls(blocks) || blocks.length
  const summary = summarizeToolRun(blocks)
  const hasFailure = blocks.some((block) => isToolResultBlock(block) && block.isError)
  const fallbackLabel = translate(
    callCount === 1 ? 'components.native-chat.tool.countOne' : 'components.native-chat.tool.countN',
    callCount === 1 ? '1 tool call' : `${callCount} tool calls`,
    { count: callCount }
  )

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <SquareChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground">
          {callCount}×
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {summary || fallbackLabel}
        </span>
        {hasFailure ? (
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-destructive">
            <AlertCircle className="size-3" />
            {translate('components.native-chat.tool.failed', 'Failed')}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 border-l-2 border-border/60 pl-2.5">
          {blocks.map((block, i) => (
            <ToolLine key={i} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
