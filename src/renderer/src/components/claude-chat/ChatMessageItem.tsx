import React, { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ChatItem } from './chat-message-model'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { ChatCheckpointControls } from './ChatCheckpointRow'
import { describeToolSummary } from './tool-activity'

type Props = {
  item: ChatItem
  // Checkpoint paired with this user message — shown as hover controls.
  checkpoint?: Extract<ChatItem, { role: 'checkpoint' }>
  cwd?: string | null
  onCheckpointReverted?: (timeLabel: string) => void
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}…` : str
}

// Timeline row: bullet dot + content, like the official GUI's activity feed.
function TimelineRow({
  dotClass,
  children
}: {
  dotClass: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 pl-1">
      <span className={cn('mt-[5px] size-[7px] rounded-full shrink-0', dotClass)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function bashCommandOf(input: unknown): string | null {
  if (input !== null && typeof input === 'object' && 'command' in input) {
    const cmd = (input as { command: unknown }).command
    if (typeof cmd === 'string') {
      return cmd
    }
  }
  return null
}

function ToolUseRow({
  item
}: {
  item: Extract<ChatItem, { role: 'tool_use' }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const summary = describeToolSummary(item.toolName, item.input)
  // IN: the bash command when present, otherwise the raw input JSON.
  const inPreview = bashCommandOf(item.input) ?? truncate(JSON.stringify(item.input) ?? '', 200)
  const outPreview = item.result != null ? truncate(item.result, 400) : null
  const done = item.result != null

  return (
    <TimelineRow dotClass={done && !item.isError ? 'bg-emerald-500/80' : item.isError ? 'bg-destructive' : 'bg-muted-foreground/50'}>
      <button
        type="button"
        className="flex w-full items-baseline gap-1.5 text-left text-sm"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-semibold text-foreground shrink-0">{item.toolName}</span>
        {summary && (
          <span className="text-muted-foreground font-mono text-xs truncate">{summary}</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-md border border-border bg-card/50 overflow-hidden text-xs font-mono">
          <div className="flex gap-2 px-2.5 py-1.5">
            <span className="text-muted-foreground/60 shrink-0 select-none">IN</span>
            <span className="text-muted-foreground break-all whitespace-pre-wrap">{inPreview}</span>
          </div>
          {outPreview != null && (
            <div className="flex gap-2 px-2.5 py-1.5 border-t border-border">
              <span className="text-muted-foreground/60 shrink-0 select-none">OUT</span>
              <span
                className={cn(
                  'break-all whitespace-pre-wrap',
                  item.isError ? 'text-destructive' : 'text-foreground/80'
                )}
              >
                {outPreview}
              </span>
            </div>
          )}
        </div>
      )}
    </TimelineRow>
  )
}

function ThinkingRow({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <TimelineRow dotClass="bg-muted-foreground/40">
      <button
        type="button"
        className="text-sm text-muted-foreground hover:text-foreground transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        Thought process
      </button>
      {expanded && (
        <p className="mt-1 text-xs italic text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </p>
      )}
    </TimelineRow>
  )
}

export function ChatMessageItem({
  item,
  checkpoint,
  cwd,
  onCheckpointReverted
}: Props): React.JSX.Element | null {
  if (item.role === 'checkpoint') {
    // Why: checkpoints render as hover controls on their paired user message
    // (merged by the panel) — never as a standalone divider in the flow.
    return null
  }

  if (item.role === 'thinking') {
    return <ThinkingRow text={item.text} />
  }

  if (item.role === 'info') {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-muted-foreground italic px-2">{item.text}</span>
      </div>
    )
  }

  if (item.role === 'user') {
    return (
      <div className="group flex justify-end items-center gap-2">
        {/* Checkpoint controls fade in on hover, left of the bubble — no layout shift. */}
        {checkpoint && cwd && (
          <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <ChatCheckpointControls
              sha={checkpoint.sha}
              createdAt={checkpoint.createdAt}
              label={checkpoint.label}
              cwd={cwd}
              onReverted={(timeLabel) => onCheckpointReverted?.(timeLabel)}
            />
          </div>
        )}
        <div className="max-w-[85%] rounded-lg bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {item.text}
        </div>
      </div>
    )
  }

  if (item.role === 'assistant') {
    return (
      <div className="flex justify-start">
        {/* Why: assistant replies are markdown from Claude; document variant gives
            proper heading/paragraph/code-block sizing for a full-width chat panel. */}
        <CommentMarkdown
          content={item.text}
          variant="document"
          className="max-w-[90%] text-sm text-foreground"
        />
      </div>
    )
  }

  // tool_use
  return <ToolUseRow item={item} />
}
