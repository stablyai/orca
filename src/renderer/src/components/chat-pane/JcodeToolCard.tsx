// Why: M2 renders each jcode tool call as a card (name, pretty args, output or
// error) instead of the M1 one-line placeholder. The bash tool is special-cased
// to show the command + its output the way the jcode-desktop prototype does, and
// any output that looks like a unified diff is rendered with the diff colorizer.
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { UnifiedDiff, looksLikeUnifiedDiff } from './jcode-diff'

/** Lifecycle/render state of one tool call, accumulated from tool_start /
 *  tool_input (concatenated arg deltas) / tool_exec / tool_done events. */
export type JcodeToolCall = {
  id: string
  name: string
  /** Concatenated tool_input deltas (a JSON string fragment). */
  rawInput: string
  /** Set once tool_done arrives. */
  output?: string
  error?: string
  status: 'running' | 'done' | 'error'
}

function parseArgs(rawInput: string): Record<string, unknown> | null {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function prettyArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2)
}

function statusGlyph(status: JcodeToolCall['status']): string {
  if (status === 'running') {
    return '⏳'
  }
  if (status === 'error') {
    return '✕'
  }
  return '✓'
}

function OutputBlock({ text }: { text: string }): React.JSX.Element {
  if (looksLikeUnifiedDiff(text)) {
    return <UnifiedDiff text={text} />
  }
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
      {text}
    </pre>
  )
}

export function JcodeToolCard({ call }: { call: JcodeToolCall }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const args = parseArgs(call.rawInput)
  const isBash = call.name === 'bash' || call.name === 'shell'
  const bashCommand =
    isBash && args && typeof args.command === 'string' ? (args.command as string) : null

  return (
    <div className="rounded-md border border-border bg-background/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left font-medium"
      >
        <span>{statusGlyph(call.status)}</span>
        <span className="text-foreground">{call.name}</span>
        {bashCommand ? (
          <span className="truncate font-mono text-muted-foreground">{bashCommand}</span>
        ) : null}
        <span className="ml-auto text-muted-foreground">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-border px-2 py-1.5">
          {bashCommand ? (
            <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">
              {`$ ${bashCommand}`}
            </pre>
          ) : args ? (
            <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">
              {prettyArgs(args)}
            </pre>
          ) : call.rawInput.trim() ? (
            <pre className="overflow-x-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap break-words">
              {call.rawInput}
            </pre>
          ) : null}
          {call.error ? (
            <div className="rounded-md bg-destructive/15 p-2 text-destructive">
              <OutputBlock text={call.error} />
            </div>
          ) : call.output !== undefined && call.output !== '' ? (
            <OutputBlock text={call.output} />
          ) : call.status === 'running' ? (
            <div className={cn('text-muted-foreground')}>running…</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
