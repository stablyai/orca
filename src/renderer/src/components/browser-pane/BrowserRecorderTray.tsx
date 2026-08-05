import React, { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDot,
  Copy,
  CornerDownRight,
  Crosshair,
  MessageSquarePlus,
  MousePointerClick,
  Navigation,
  Trash2
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { BrowserRecorderStep } from './browser-recorder-types'
import { formatBrowserRecorderStepSummary, stepGapLabel } from './browser-recorder-output'
import { formatTime } from './browser-recorder-text'
import { groupRecorderSteps } from './browser-recorder-grouping'

function StepIcon({ step }: { step: BrowserRecorderStep }): React.JSX.Element {
  const className = 'size-3 shrink-0 text-muted-foreground'
  switch (step.detail.kind) {
    case 'navigation':
      return <Navigation className={className} />
    case 'element-selected':
      return <Crosshair className={className} />
    case 'annotation-added':
      return <MessageSquarePlus className={className} />
    case 'automation-action':
      return <MousePointerClick className={className} />
    case 'interaction':
    case 'console':
    case 'network-request':
    case 'network-summary':
      return <CircleDot className={className} />
    case 'recording-started':
      return <CircleDot className={className} />
  }
}

function formatPageHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export type BrowserRecorderTrayProps = {
  steps: BrowserRecorderStep[]
  recording: boolean
  copied: boolean
  onCopy: () => void
  onClear: () => void
}

export function BrowserRecorderTray({
  steps,
  recording,
  copied,
  onCopy,
  onClear
}: BrowserRecorderTrayProps): React.JSX.Element {
  const stepCount = steps.length
  const title = recording
    ? translate(
        'auto.components.browser.pane.BrowserRecorderTray.0292ce4993',
        'Recording — {{value0}} steps',
        { value0: stepCount }
      )
    : translate(
        'auto.components.browser.pane.BrowserRecorderTray.91cd8adfdb',
        'Recorded session — {{value0}} steps',
        { value0: stepCount }
      )
  const [expanded, setExpanded] = useState(false)
  // Why: the collapsed bar is the default state — it shows the recording
  // status and the latest event on one thin line, so it does not cover the
  // page; the full log appears only when the user expands it.
  if (!expanded) {
    return (
      <CollapsedTrayBar
        recording={recording}
        stepCount={stepCount}
        lastStep={steps.at(-1)}
        copied={copied}
        onCopy={onCopy}
        onClear={onClear}
        onExpand={() => setExpanded(true)}
      />
    )
  }

  return (
    <div className="absolute bottom-3 left-3 z-30 flex max-h-[45%] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <CircleDot className={cnIcon(recording)} aria-hidden />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
        <Button
          size="xs"
          variant="outline"
          className="gap-1.5"
          onClick={onCopy}
          disabled={stepCount === 0}
        >
          {copied ? <CircleCheck className="size-3" /> : <Copy className="size-3" />}
          {copied
            ? translate('auto.components.browser.pane.BrowserRecorderTray.d101b4ca91', 'Copied')
            : translate('auto.components.browser.pane.BrowserRecorderTray.5d4bb3794d', 'Copy Log')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={onClear}
              disabled={stepCount === 0}
              aria-label={translate(
                'auto.components.browser.pane.BrowserRecorderTray.0b9a88486c',
                'Clear recorded log'
              )}
            >
              <Trash2 className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.browser.pane.BrowserRecorderTray.f23f6712a2', 'Clear log')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(false)}
              aria-label={translate(
                'auto.components.browser.pane.BrowserRecorderTray.collapse',
                'Collapse log'
              )}
            >
              <ChevronDown className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.browser.pane.BrowserRecorderTray.collapse', 'Collapse log')}
          </TooltipContent>
        </Tooltip>
      </div>
      <div
        role="log"
        aria-live="polite"
        className="scrollbar-sleek min-h-0 flex-1 space-y-0.5 overflow-auto p-1.5"
      >
        {(() => {
          // Why: a shared step counter (lead + items) keeps the on-screen
          // numbers identical to the copied markdown log's numbering. Each
          // group renders as one block: the lead row, then its member rows
          // hung off a left guide line with a └ branch; hover/scroll rows
          // render inline (flat) inside the block, mirroring the markdown.
          const rows: React.JSX.Element[] = []
          let stepNumber = 0
          let previousAt: string | undefined
          for (const group of groupRecorderSteps(steps)) {
            if (group.lead) {
              const leadNumber = stepNumber + 1
              stepNumber += 1
              const leadGap = stepGapLabel(group.lead.createdAt, previousAt)
              previousAt = group.lead.createdAt
              const blockChildren: React.JSX.Element[] = []
              for (const item of group.items) {
                stepNumber += 1
                const itemGap = stepGapLabel(item.step.createdAt, previousAt)
                previousAt = item.step.createdAt
                blockChildren.push(
                  <StepRow
                    key={item.step.id}
                    step={item.step}
                    number={stepNumber}
                    nested={item.kind === 'member'}
                    gap={itemGap}
                  />
                )
              }
              rows.push(
                <div key={group.lead.id} className="overflow-hidden rounded-md">
                  <StepRow step={group.lead} number={leadNumber} gap={leadGap} />
                  {blockChildren.length > 0 && (
                    <div className="ml-3 border-l border-border/70 pl-2.5">{blockChildren}</div>
                  )}
                </div>
              )
            } else {
              for (const item of group.items) {
                stepNumber += 1
                const itemGap = stepGapLabel(item.step.createdAt, previousAt)
                previousAt = item.step.createdAt
                rows.push(
                  <div key={item.step.id} className="overflow-hidden rounded-md">
                    <StepRow step={item.step} number={stepNumber} gap={itemGap} />
                  </div>
                )
              }
            }
          }
          return rows
        })()}
      </div>
    </div>
  )
}

/**
 * Thin one-line bar shown while the tray is collapsed: recording status dot,
 * the latest captured event, and an expand affordance. Stays out of the way
 * of the page so the recorder does not cover the app being recorded.
 */
function CollapsedTrayBar({
  recording,
  stepCount,
  lastStep,
  copied,
  onCopy,
  onClear,
  onExpand
}: {
  recording: boolean
  stepCount: number
  lastStep: BrowserRecorderStep | undefined
  copied: boolean
  onCopy: () => void
  onClear: () => void
  onExpand: () => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-3 left-3 z-30 w-[min(20rem,calc(100%-1.5rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-floating">
      <div className="flex items-center gap-1 px-3 py-1.5">
        <button
          type="button"
          onClick={onExpand}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs hover:bg-accent -mx-1 px-1 rounded"
          aria-label={translate(
            'auto.components.browser.pane.BrowserRecorderTray.expand',
            'Expand log'
          )}
        >
          <CircleDot className={cnIcon(recording)} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-foreground">
            {lastStep ? formatBrowserRecorderStepSummary(lastStep) : ''}
          </span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
            {stepCount}
          </span>
        </button>
        <button
          type="button"
          onClick={onCopy}
          disabled={stepCount === 0}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
          aria-label={
            copied
              ? translate('auto.components.browser.pane.BrowserRecorderTray.d101b4ca91', 'Copied')
              : translate('auto.components.browser.pane.BrowserRecorderTray.5d4bb3794d', 'Copy Log')
          }
        >
          {copied ? <CircleCheck className="size-3" /> : <Copy className="size-3" />}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={stepCount === 0}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
          aria-label={translate(
            'auto.components.browser.pane.BrowserRecorderTray.0b9a88486c',
            'Clear recorded log'
          )}
        >
          <Trash2 className="size-3" />
        </button>
        <ChevronUp className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </div>
    </div>
  )
}

function StepRow({
  step,
  number,
  nested = false,
  gap
}: {
  step: BrowserRecorderStep
  number: number
  nested?: boolean
  gap?: string
}): React.JSX.Element {
  return (
    <div
      className={`group flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs hover:bg-accent focus-within:bg-accent${
        nested ? ' bg-muted/40' : ' font-medium'
      }`}
    >
      {nested && (
        <CornerDownRight className="mt-1 size-3 shrink-0 text-muted-foreground/60" aria-hidden />
      )}
      <div
        className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold${
          nested ? ' bg-muted text-muted-foreground' : ' bg-primary text-primary-foreground'
        }`}
      >
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground">
          {gap ? <span className="mr-1 text-muted-foreground">{gap}</span> : null}
          {formatBrowserRecorderStepSummary(step)}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <StepIcon step={step} />
          <span className="min-w-0 flex-1 truncate">{formatPageHost(step.pageUrl)}</span>
          <span className="shrink-0">{formatTime(step.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

function cnIcon(recording: boolean): string {
  return recording
    ? 'size-4 shrink-0 animate-pulse text-destructive'
    : 'size-4 shrink-0 text-muted-foreground'
}
