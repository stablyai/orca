import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { briefToolArg } from './native-chat-tool-summary'
import {
  buildNativeChatTurnActivity,
  type NativeChatActivityStatus,
  type NativeChatActivityStep
} from './native-chat-turn-activity'
import { collectNativeChatReportedFileChanges } from './native-chat-reported-file-changes'
import { NativeChatActivityStatusIcon, NativeChatToolStep } from './NativeChatToolStep'
import { NativeChatReportedFiles } from './NativeChatReportedFiles'

function summaryText(activityStep: NativeChatActivityStep): string {
  const { call, result } = activityStep.step
  if (!call) {
    return (
      result.output.split('\n')[0]?.slice(0, 80) ||
      translate('components.native-chat.tool.result', 'Result')
    )
  }
  const detail = briefToolArg(call.input)
  return detail ? `${call.name} ${detail}` : call.name
}

function statusText(status: NativeChatActivityStatus): string {
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

/** A compact operation run. Completed work stays collapsed by default; opening
 * it reveals one row per call/result lifecycle, each with its own details. */
export function NativeChatToolRun({
  blocks,
  expandSignal,
  isWorking = false,
  onLinkClick
}: {
  blocks: NativeChatBlock[]
  expandSignal: boolean
  isWorking?: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element | null {
  const [open, setOpen] = useState(expandSignal)
  useEffect(() => setOpen(expandSignal), [expandSignal])

  const activity = useMemo(
    () => buildNativeChatTurnActivity(blocks, isWorking),
    [blocks, isWorking]
  )
  const reportedFiles = useMemo(
    () => collectNativeChatReportedFileChanges(activity?.steps.map((item) => item.step) ?? []),
    [activity]
  )
  if (!activity) {
    return null
  }

  const activityLabel = translate(
    activity.steps.length === 1
      ? 'components.native-chat.tool.activityOne'
      : 'components.native-chat.tool.activityMany',
    activity.steps.length === 1 ? '1 activity' : `${activity.steps.length} activities`,
    { count: activity.steps.length }
  )
  const runningStep = activity.steps.findLast((item) => item.status === 'running') ?? null
  const showConcurrentRunning = activity.status === 'failed' && Boolean(isWorking || runningStep)
  // Why: a failed retry must remain visible without hiding the operation that
  // is currently running or the latest work while the provider continues.
  const collapsedSummaryStep = showConcurrentRunning
    ? (runningStep ?? activity.steps.at(-1)!)
    : activity.summaryStep
  const stateLabel = statusText(activity.status)

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 rounded-sm py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <NativeChatActivityStatusIcon status={activity.status} />
        <span className="shrink-0 font-mono text-[11px] font-semibold text-muted-foreground group-hover:text-foreground/80">
          {activityLabel}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground group-hover:text-foreground/80">
          · {summaryText(collapsedSummaryStep)}
        </span>
        <span
          className={cn(
            activity.status === 'completed'
              ? 'sr-only'
              : 'ml-auto shrink-0 text-[11px] text-muted-foreground',
            activity.status === 'failed' && 'text-destructive'
          )}
        >
          {stateLabel}
        </span>
        {showConcurrentRunning ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            · {statusText('running')}
          </span>
        ) : null}
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
      </button>
      {open ? (
        <div className="ml-1.5 border-l border-border pl-3">
          {activity.steps.map((item) => (
            <NativeChatToolStep key={item.step.operationKey} activityStep={item} />
          ))}
        </div>
      ) : null}
      <NativeChatReportedFiles
        collection={reportedFiles}
        steps={activity.steps.map((item) => item.step)}
        onLinkClick={onLinkClick}
      />
    </div>
  )
}
