import { useState } from 'react'
import { CircleAlert, CircleCheck, CircleX, ChevronRight, Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatActivityStatus, NativeChatActivityStep } from './native-chat-turn-activity'
import { projectDiffFromText, projectDiffFromToolCall } from './native-chat-diff'
import { formatToolInput, summarizeToolInput } from './native-chat-tool-summary'
import { NativeChatDiffView } from './NativeChatDiffView'

const MAX_TOOL_DETAIL_CHARS = 4000

export function NativeChatActivityStatusIcon({
  status
}: {
  status: NativeChatActivityStatus
}): React.JSX.Element {
  if (status === 'running') {
    return (
      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
    )
  }
  if (status === 'failed') {
    return <CircleX className="size-3.5 shrink-0 text-destructive" />
  }
  if (status === 'incomplete') {
    return <CircleAlert className="size-3.5 shrink-0 text-muted-foreground" />
  }
  return <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" />
}

function bounded(value: string): string {
  return value.length > MAX_TOOL_DETAIL_CHARS ? `${value.slice(0, MAX_TOOL_DETAIL_CHARS)}…` : value
}

function statusLabel(status: NativeChatActivityStatus): string {
  if (status === 'running') {
    return translate('components.native-chat.tool.running', 'Running…')
  }
  if (status === 'failed') {
    return translate('components.native-chat.tool.failed', 'Failed')
  }
  if (status === 'incomplete') {
    return translate('components.native-chat.tool.incomplete', 'Incomplete')
  }
  return translate('components.native-chat.tool.completed', 'Completed')
}

/** One operation lifecycle row. The call and its result share a disclosure so
 * expanding a run no longer repeats each operation as two disconnected rows. */
export function NativeChatToolStep({
  activityStep
}: {
  activityStep: NativeChatActivityStep
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { call, result } = activityStep.step
  const name = call?.name || translate('components.native-chat.tool.result', 'Result')
  const preview = call
    ? summarizeToolInput(call.input)
    : (result.output.split('\n')[0]?.slice(0, 80) ?? '')
  const callDiff = call ? projectDiffFromToolCall(call.name, call.input) : null
  const inputDetail = call && !callDiff ? formatToolInput(call.input) : ''
  const resultText = result ? bounded(result.output) : ''
  const resultDiff = resultText ? projectDiffFromText(resultText) : null
  const resultWasTruncated = Boolean(result && result.output.length > MAX_TOOL_DETAIL_CHARS)
  const hasDetail = Boolean(callDiff || inputDetail || resultText)
  const label = statusLabel(activityStep.status)
  const rowContent = (
    <>
      <NativeChatActivityStatusIcon status={activityStep.status} />
      <code className="shrink-0 font-mono text-xs font-semibold text-foreground/90">{name}</code>
      {preview ? (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          {preview}
        </span>
      ) : null}
      <span
        className={cn(
          activityStep.status === 'completed'
            ? 'sr-only'
            : 'ml-auto shrink-0 text-[11px] text-muted-foreground',
          activityStep.status === 'failed' && 'text-destructive'
        )}
      >
        {label}
      </span>
      {hasDetail ? (
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      ) : null}
    </>
  )

  return (
    <div>
      {hasDetail ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="group flex w-full items-center gap-1.5 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rowContent}
        </button>
      ) : (
        <div className="flex w-full items-center gap-1.5 py-1 text-left">{rowContent}</div>
      )}
      {hasDetail && open ? (
        <div className="space-y-2 pt-1 pb-2 pl-5">
          {callDiff ? (
            <NativeChatDiffView lines={callDiff.lines} truncated={callDiff.truncated} />
          ) : null}
          {inputDetail ? (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {translate('components.native-chat.tool.input', 'Input')}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] text-foreground/80 scrollbar-sleek">
                {bounded(inputDetail)}
              </pre>
            </div>
          ) : null}
          {resultText ? (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">
                {translate('components.native-chat.tool.output', 'Output')}
              </div>
              {resultDiff ? (
                <NativeChatDiffView
                  lines={resultDiff.lines}
                  truncated={resultDiff.truncated || resultWasTruncated}
                />
              ) : (
                <pre
                  className={cn(
                    'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-[11px] scrollbar-sleek',
                    result?.isError ? 'text-destructive' : 'text-foreground/80'
                  )}
                >
                  {resultText}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
