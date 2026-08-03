import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { countToolCalls, summarizeToolRun } from './native-chat-tool-summary'
import { deriveToolLine } from './native-chat-tool-line'
import { NativeChatDiffView } from './NativeChatDiffView'

const MAX_VISIBLE_TOOL_LINES = 24

/** A single inline tool line — `▸ ToolName  preview` — that expands in place to
 *  show the call's diff/input or the result's body. Tool calls read as flat
 *  lines in the conversation rather than boxed blocks (mobile parity). Lines only
 *  mount while the parent run is open, so each starts expanded (opening the run
 *  reveals every line at once) and is then individually collapsible. */
function ToolLine({ block }: { block: NativeChatBlock }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  const model = useMemo(() => deriveToolLine(block), [block])

  if (!model) {
    return null
  }
  const { name, preview, diff, body, detail, hasDetail } = model

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
              {body.output}
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
  // A long run mounts every line at once, and each line carries a diff or a
  // formatted input — so cap the initial reveal and let the user ask for the
  // rest. Mobile caps the equivalent at MAX_VISIBLE_TOOL_PAIRS.
  const [showAll, setShowAll] = useState(false)
  // Re-sync when the global toolbar toggle flips.
  useEffect(() => setOpen(expandSignal), [expandSignal])

  const visibleBlocks =
    showAll || blocks.length <= MAX_VISIBLE_TOOL_LINES
      ? blocks
      : blocks.slice(0, MAX_VISIBLE_TOOL_LINES)
  const hiddenCount = blocks.length - visibleBlocks.length

  const callCount = countToolCalls(blocks) || blocks.length
  const summary = summarizeToolRun(blocks)
  const fallbackLabel =
    callCount === 1
      ? translate('components.native-chat.tool.countOne', '1 tool call')
      : translate('components.native-chat.tool.countN', '{{value0}} tool calls', {
          value0: callCount
        })

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
          {visibleBlocks.map((block, i) => (
            <ToolLine key={i} block={block} />
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground/80"
            >
              {translate('components.native-chat.tool.showAllLines', 'Show all lines')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
