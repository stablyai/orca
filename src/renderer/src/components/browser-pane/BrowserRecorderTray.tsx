import React from 'react'
import {
  CircleCheck,
  CircleDot,
  Copy,
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
import { formatBrowserRecorderStepSummary } from './browser-recorder-output'

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
    case 'network-summary':
      return <CircleDot className={className} />
    case 'recording-started':
      return <CircleDot className={className} />
  }
}

function formatStepTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

  return (
    <div className="absolute bottom-3 left-3 z-30 flex max-h-[45%] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
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
      </div>
      <div
        role="log"
        aria-live="polite"
        className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-1.5"
      >
        {steps.map((step, index) => (
          <div
            key={step.id}
            className="group flex gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent focus-within:bg-accent"
          >
            <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">
                {formatBrowserRecorderStepSummary(step)}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <StepIcon step={step} />
                <span className="min-w-0 flex-1 truncate">{formatPageHost(step.pageUrl)}</span>
                <span className="shrink-0">{formatStepTime(step.createdAt)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function cnIcon(recording: boolean): string {
  return recording
    ? 'size-4 shrink-0 animate-pulse text-red-500'
    : 'size-4 shrink-0 text-muted-foreground'
}
