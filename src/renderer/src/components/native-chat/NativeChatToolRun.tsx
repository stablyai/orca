import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock
} from '../../../../shared/native-chat-types'
import { diffFromText, diffFromToolCall, type DiffLine } from './native-chat-diff'
import {
  countToolCalls,
  formatToolInput,
  summarizeToolInput,
  summarizeToolRun
} from './native-chat-tool-summary'
import { NativeChatDiffView } from './NativeChatDiffView'

const MAX_TOOL_RESULT_CHARS = 4000

/** A single inline tool line — `▸ ToolName  preview` — that expands in place to
 *  show the call's diff/input or the result's body. Tool calls read as flat
 *  lines in the conversation rather than boxed blocks (mobile parity). Lines only
 *  mount while the parent run is open, so each starts expanded (opening the run
 *  reveals every line at once) and is then individually collapsible. */
function ToolLine({ block }: { block: NativeChatBlock }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)

  let name: string
  let preview: string
  let diff: DiffLine[] | null = null
  let body: { output: string; isError?: boolean } | null = null
  // Full, formatted input shown when a diff-less tool call is expanded.
  let detail: string | null = null

  if (isToolCallBlock(block)) {
    name = block.name
    preview = summarizeToolInput(block.input)
    diff = diffFromToolCall(block.name, block.input)
    detail = diff ? null : formatToolInput(block.input)
  } else if (isToolResultBlock(block)) {
    name = translate('components.native-chat.tool.result', 'Result')
    preview = block.output.split('\n')[0]?.slice(0, 80) ?? ''
    diff = diffFromText(block.output)
    body = { output: block.output, isError: block.isError }
  } else {
    return null
  }

  // Only offer expansion when there's more than the inline preview already shows —
  // avoids re-rendering the same truncated string in a box below it.
  const detailAddsInfo = detail !== null && detail.replace(/\s+/g, ' ').trim() !== preview
  const hasDetail = diff !== null || body !== null || detailAddsInfo

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={cn(
          'group flex w-full items-center gap-1.5 py-0.5 text-left',
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        <code className="shrink-0 font-mono text-xs font-semibold text-foreground/90 transition-colors group-hover:text-foreground">
          {name}
        </code>
        {preview ? (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/70"
            title={preview}
          >
            {preview}
          </span>
        ) : null}
        {hasDetail ? (
          // Chevron sits on the right; hidden until hover when collapsed, always
          // shown (pointing down) when expanded — mirrors Codex's disclosure affordance.
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
          {!diff && !body && detail ? (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] text-foreground/80 scrollbar-sleek">
              {detail.length > MAX_TOOL_RESULT_CHARS
                ? `${detail.slice(0, MAX_TOOL_RESULT_CHARS)}…`
                : detail}
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
  const fallbackLabel = translate(
    callCount === 1 ? 'components.native-chat.tool.countOne' : 'components.native-chat.tool.countN',
    callCount === 1 ? '1 tool call' : `${callCount} tool calls`,
    { count: callCount }
  )

  return (
    // Extra top margin sets the tool run apart from the assistant prose above it
    // so the turn's activity doesn't crowd the message text.
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-center gap-1.5 py-0.5 text-left"
      >
        <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground transition-colors group-hover:text-foreground/80">
          {callCount}×
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/80">
          {summary || fallbackLabel}
        </span>
        {/* Chevron on the right, revealed on hover when collapsed and pointing
            down when open — matches Codex's tool-run disclosure. */}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-all',
            open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
        />
      </button>
      {open ? (
        <div className="mt-1">
          {blocks.map((block, i) => (
            <ToolLine key={i} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
