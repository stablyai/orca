// The 56 px strip at the top of an Orca Cloud pane (redesign §6). Fixed slots: status 16, two text
// lines, the queued prompt chip (140, hidden below 720 px), actions (280, or 200 below 560 px).
// A region, never a dialog; one polite status sentence per state.
import React, { useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Loader2,
  MoreHorizontal,
  TriangleAlert,
  X
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  CloudStripModel,
  CloudStripPrimary,
  CloudStripStatus
} from './cloud-agent-strip-model'

export type CloudStripWidth = 'wide' | 'narrow' | 'tiny'

export function cloudStripWidth(paneWidth: number): CloudStripWidth {
  return paneWidth < 560 ? 'tiny' : paneWidth < 720 ? 'narrow' : 'wide'
}

export type CloudStripActions = {
  primary: (action: CloudStripPrimary) => void
  submitCode: (code: string) => void
  useCode: () => void
  /** From a device code to pasting a code (the gate's code fallback). */
  pasteCode: () => void
  useApiKey: () => void
  cancel: () => void
}

function StatusSlot({ status }: { status: CloudStripStatus }): React.JSX.Element {
  const base = 'size-4 shrink-0'
  switch (status) {
    case 'need':
      return <CircleDashed aria-hidden className={cn(base, 'text-muted-foreground')} />
    case 'warning':
      return <TriangleAlert aria-hidden className={cn(base, 'text-status-warning-text')} />
    case 'busy':
      return (
        <Loader2
          aria-hidden
          className={cn(base, 'text-muted-foreground motion-safe:animate-spin')}
        />
      )
    case 'error':
      return <CircleAlert aria-hidden className={cn(base, 'text-destructive')} />
    case 'done':
      return <CircleCheck aria-hidden className={cn(base, 'text-muted-foreground')} />
  }
}

const GRID: Record<CloudStripWidth, string> = {
  wide: 'grid-cols-[16px_minmax(0,1fr)_140px_280px]',
  narrow: 'grid-cols-[16px_minmax(0,1fr)_280px]',
  tiny: 'grid-cols-[16px_minmax(0,1fr)_200px]'
}

export function CloudAgentSignInStrip({
  model,
  prompt,
  width,
  actions
}: {
  model: CloudStripModel
  prompt: string | null
  /** Decided once at mount from the pane's width. */
  width: CloudStripWidth
  actions: CloudStripActions
}): React.JSX.Element {
  const t = useTranslate()
  const titleId = React.useId()
  const detailId = React.useId()
  const [code, setCode] = useState('')
  const primary = model.primary
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      tabIndex={-1}
      data-cloud-sign-in-strip
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          actions.cancel()
        }
      }}
      className={cn(
        'grid h-14 items-center gap-2.5 border-b border-border bg-card px-3 text-foreground outline-none',
        GRID[width]
      )}
    >
      <StatusSlot status={model.status} />
      <div data-strip-text className="flex min-w-0 flex-col">
        <span id={titleId} className="truncate text-[13px] leading-5 font-medium">
          {model.title}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span id={detailId} className="truncate text-xs leading-4 text-muted-foreground">
              {model.detail}
              {model.description ? <span className="sr-only">. {model.description}</span> : null}
            </span>
          </TooltipTrigger>
          {model.description ? <TooltipContent>{model.description}</TooltipContent> : null}
        </Tooltip>
      </div>
      {width === 'wide' ? (
        prompt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={t('agentSignInStrip.queued', 'Queued prompt: {{prompt}}', { prompt })}
                className="truncate rounded-md border border-border px-2 py-1 text-xs text-foreground"
              >
                <span aria-hidden className="text-muted-foreground">
                  {t('agentSignInStrip.queuedPrefix', 'Queued:')}{' '}
                </span>
                <span aria-hidden>{prompt}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-80 whitespace-pre-wrap">{prompt}</TooltipContent>
          </Tooltip>
        ) : (
          <span />
        )
      ) : null}
      <div data-strip-actions className="flex h-8 min-w-0 items-center justify-end gap-1.5">
        {model.code ? (
          <code className="shrink-0 select-all rounded bg-muted px-1.5 font-mono text-xs tracking-wider">
            {model.code}
          </code>
        ) : null}
        {model.paste ? (
          <form
            className="flex min-w-0 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              if (code.trim()) {
                actions.submitCode(code.trim())
              }
            }}
          >
            <Input
              aria-label={t('agentSignInStrip.pasteLabel', 'Code from claude.ai')}
              aria-invalid={model.paste.refusal ? true : undefined}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              variant="code"
              className="h-7 min-w-0"
            />
            <Button
              type="submit"
              size="xs"
              aria-busy={model.paste.submitting || undefined}
              aria-disabled={model.paste.submitting || undefined}
            >
              {t('agentSignInStrip.continue', 'Continue')}
            </Button>
          </form>
        ) : null}
        {primary ? (
          <Button
            type="button"
            size="xs"
            variant={model.status === 'error' ? 'outline' : 'default'}
            aria-busy={primary.busy || undefined}
            aria-disabled={primary.busy || undefined}
            onClick={() => (primary.busy ? undefined : actions.primary(primary.action))}
          >
            {width === 'tiny' && primary.narrowLabel ? primary.narrowLabel : primary.label}
          </Button>
        ) : null}
        {model.otherWays ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('agentSignInStrip.otherWays', 'Other ways')}
              >
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {model.codeStep ? (
                <>
                  <DropdownMenuItem onSelect={actions.pasteCode}>
                    {t('agentSignInStrip.pasteInstead', 'Paste a code instead')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={actions.cancel}>
                    {t('agentSignInStrip.cancelSignIn', 'Cancel sign-in')}
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onSelect={actions.useCode}>
                  {t('agentSignInStrip.useCodeInstead', 'Use a code instead')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={actions.useApiKey}>
                {t('agentSignInStrip.useApiKey', 'Use an API key instead')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {model.status === 'done' ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('agentSignInStrip.cancel', 'Cancel sign-in (Esc)')}
            onClick={actions.cancel}
          >
            <X aria-hidden />
          </Button>
        )}
      </div>
      <span role="status" className="sr-only">
        {model.announcement}
      </span>
      {model.paste?.refusal ? (
        <span role="alert" className="sr-only">
          {model.paste.refusal}
        </span>
      ) : null}
    </section>
  )
}
