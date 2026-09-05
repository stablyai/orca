import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, SquareTerminal, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  isToolCallBlock,
  isToolResultBlock,
  type NativeChatBlock
} from '../../../../shared/native-chat-types'
import { diffFromText, diffFromToolCall, type DiffLine } from './native-chat-diff'
import { NativeChatDiffCard } from './NativeChatDiffCard'
import { pairToolBlocks } from './native-chat-tool-fold'
import {
  editFilesFromToolPair,
  isEditToolName
} from '../../../../shared/native-chat-edit-normalize'
import type { NativeChatEditFile } from '../../../../shared/native-chat-edit-model'
import {
  countToolCalls,
  createToolInputDisplay,
  summarizeToolRun,
  truncateToolDetail
} from './native-chat-tool-summary'
import {
  describeActiveToolCall,
  isCommandToolName,
  NATIVE_CHAT_TOOL_ACTIVITY_COPY,
  selectActiveToolCall
} from '../../../../shared/native-chat-tool-activity'
import { NativeChatDiffView } from './NativeChatDiffView'

function activeToolLabel(call: Extract<NativeChatBlock, { type: 'tool-call' }>): string {
  const { key, toolName, preview } = describeActiveToolCall(call)
  const copy = NATIVE_CHAT_TOOL_ACTIVITY_COPY[key]
  return key === 'runningPreview'
    ? translate('components.native-chat.tool.runningPreview', copy, { preview })
    : key === 'runningCommand'
      ? translate('components.native-chat.tool.runningCommand', copy)
      : key === 'runningNamedPreview'
        ? translate('components.native-chat.tool.runningNamedPreview', copy, { toolName, preview })
        : translate('components.native-chat.tool.runningNamed', copy, { toolName })
}

/** A single inline tool line — `▸ ToolName  preview` — that expands in place to
 *  show the call's diff/input or the result's body. Tool calls read as flat
 *  lines in the conversation rather than boxed blocks (mobile parity). Lines only
 *  mount while the parent run is open and are individually collapsible. */
function ToolLine({
  block,
  initiallyExpanded = true
}: {
  block: NativeChatBlock
  initiallyExpanded?: boolean
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(initiallyExpanded)

  let name: string
  let preview: string
  let diff: DiffLine[] | null = null
  let body: { output: string; isError?: boolean } | null = null
  let detail: string | null = null
  let inputHasDetail = false

  if (isToolCallBlock(block)) {
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

  const hasDetail = diff !== null || body !== null || inputHasDetail

  return (
    <div>
      <button
        type="button"
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={cn(
          'group flex w-full items-center gap-1.5 py-0.5 text-left',
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        )}
        aria-expanded={hasDetail ? expanded : undefined}
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

type EditCardModel = {
  editCards: Map<NativeChatBlock, { files: NativeChatEditFile[]; key: string }>
  /** Result blocks the card already speaks for, so they render no second row. */
  consumedResults: Set<NativeChatBlock>
}

const NO_EDIT_CARDS: EditCardModel = { editCards: new Map(), consumedResults: new Set() }

/** An edit renders as one card, so its result block is folded into the call. The
 *  model decides which calls have landed; a call that has not keeps the generic
 *  tool view, its result still visible as the provider's own error. */
function buildEditCards(blocks: NativeChatBlock[]): EditCardModel {
  const editCards: EditCardModel['editCards'] = new Map()
  const consumedResults: EditCardModel['consumedResults'] = new Set()
  for (const [index, pair] of pairToolBlocks(blocks).entries()) {
    const call = pair.call
    if (!call || !isEditToolName(call.name)) {
      continue
    }
    const files = editFilesFromToolPair({
      name: call.name,
      input: call.input,
      ...(call.state ? { state: call.state } : {}),
      ...(pair.result
        ? {
            result: {
              output: pair.result.output,
              isError: pair.result.isError,
              editPatch: pair.result.editPatch
            }
          }
        : {})
    })
    if (!files || files.length === 0) {
      continue
    }
    editCards.set(call, { files, key: `${call.name}:${index}` })
    if (pair.result) {
      consumedResults.add(pair.result)
    }
  }
  return { editCards, consumedResults }
}

/** A run of a message's tool calls/results, collapsed to a one-line summary that
 *  expands to the individual inline tool lines. `expandSignal` lets the global
 *  toolbar toggle drive every run at once while still allowing per-run override. */
export function NativeChatToolRun({
  blocks,
  expandSignal,
  activeTurnIsWorking,
  expandOverride,
  structuredActivityUi = true
}: {
  blocks: NativeChatBlock[]
  /** Toolbar-driven desired open state. Each change re-syncs this run's state. */
  expandSignal: boolean
  /** Per-turn disclosure state controlled by the completed turn status row. */
  expandOverride?: boolean
  /** Structured lifecycle state, when available, keeps orphaned running calls from spinning. */
  activeTurnIsWorking?: boolean
  structuredActivityUi?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(expandOverride ?? expandSignal)
  // Re-sync when the global toolbar toggle flips.
  useEffect(() => setOpen(expandOverride ?? expandSignal), [expandOverride, expandSignal])

  const callCount = countToolCalls(blocks) || blocks.length
  const summary = summarizeToolRun(blocks)
  const latestActiveCall = structuredActivityUi
    ? selectActiveToolCall(blocks, { activeTurnIsWorking })
    : null
  const isSettled = latestActiveCall == null
  // The turn caret opens the activity group, while each child tool remains
  // collapsed. The global expand toolbar still opens child details together.
  const expandToolLines = expandOverride === undefined ? open : false
  // Diffing every edit is the run's most expensive work, so a collapsed run —
  // which renders none of it — never pays for it.
  const { editCards, consumedResults } = useMemo(
    () => (open ? buildEditCards(blocks) : NO_EDIT_CARDS),
    [open, blocks]
  )
  const ActiveToolIcon =
    latestActiveCall && isCommandToolName(latestActiveCall.name) ? SquareTerminal : Wrench
  const fallbackLabel =
    callCount === 1
      ? translate('components.native-chat.tool.countOne', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countOne)
      : translate('components.native-chat.tool.countN', NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN, {
          value0: callCount
        })

  // Completed turn activity belongs behind the turn-status disclosure. Keeping
  // the grouped row visible here made a failed child command look like the
  // whole response was still running (or had failed) even while collapsed.
  if (
    structuredActivityUi &&
    expandOverride === false &&
    isSettled &&
    activeTurnIsWorking === false
  ) {
    return null
  }

  return (
    // Extra top margin sets the tool run apart from the assistant prose above it
    // so the turn's activity doesn't crowd the message text.
    <div className="mt-3">
      {latestActiveCall ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed text-muted-foreground hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          aria-expanded={open}
          aria-live="polite"
        >
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            <ActiveToolIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 animate-pulse truncate text-foreground/85 motion-reduce:animate-none">
            {activeToolLabel(latestActiveCall)}
          </span>
          {open ? <ChevronRight className="size-3.5 rotate-90 text-muted-foreground" /> : null}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex min-h-6 w-full items-center gap-1.5 py-0.5 text-left"
          aria-expanded={open}
        >
          {structuredActivityUi ? (
            <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
              <Check className="size-3.5" />
            </span>
          ) : null}
          <span className="shrink-0 font-mono text-[11px] font-bold text-muted-foreground transition-colors group-hover:text-foreground/80">
            {callCount}×
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground transition-colors group-hover:text-foreground/80">
            {summary || fallbackLabel}
          </span>
          {/* Chevron is revealed on hover when collapsed and points down when open. */}
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-all',
              open ? 'rotate-90 opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          />
        </button>
      )}
      {open ? (
        <div className="mt-1">
          {(() => {
            const seen = new Map<string, number>()
            return blocks.map((block) => {
              const edit = editCards.get(block)
              if (edit) {
                return (
                  <div key={`edit:${edit.key}`}>
                    {edit.files.map((file, fileIndex) => (
                      <NativeChatDiffCard
                        key={`${edit.key}:${fileIndex}`}
                        file={file}
                        initiallyExpanded={expandToolLines}
                      />
                    ))}
                  </div>
                )
              }
              if (consumedResults.has(block)) {
                return null
              }
              const signature =
                block.type === 'tool-call'
                  ? `${block.type}:${block.name}:${JSON.stringify(block.input)}`
                  : block.type === 'tool-result'
                    ? `${block.type}:${block.output}`
                    : `${block.type}`
              const occurrence = seen.get(signature) ?? 0
              seen.set(signature, occurrence + 1)
              return (
                <ToolLine
                  key={`${signature}:${occurrence}`}
                  block={block}
                  initiallyExpanded={expandToolLines}
                />
              )
            })
          })()}
        </div>
      ) : null}
    </div>
  )
}
