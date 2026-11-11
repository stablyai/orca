// The 56 px strip at the top of an Orca Cloud pane (redesign §6). Fixed slots: status 16, two text
// lines, the queued prompt chip (140, hidden below 720 px), actions (280, or 200 below 560 px).
// Laid out from its own live width (RA-1): a pane narrowed after mount gets the narrow layout too.
// A region, never a dialog; one polite status sentence per state.
import React, { useLayoutEffect, useRef, useState } from 'react'
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
import { useReservePaneTopSpace } from '../terminal-pane/appearance/pane-top-banner/PaneTopWarningBanner'
import type {
  CloudStripModel,
  CloudStripPrimary,
  CloudStripStatus
} from './cloud-agent-strip-model'

export type CloudStripWidth = 'wide' | 'narrow' | 'tiny' | 'compact'

export function cloudStripWidth(paneWidth: number): CloudStripWidth {
  return paneWidth < 360
    ? 'compact'
    : paneWidth < 560
      ? 'tiny'
      : paneWidth < 720
        ? 'narrow'
        : 'wide'
}

/** The strip's own width class, followed live; the height never changes, so nothing shifts. */
function useLiveStripWidth(
  ref: React.RefObject<HTMLElement | null>,
  initial: CloudStripWidth
): CloudStripWidth {
  const [width, setWidth] = useState(initial)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const measure = (): void => setWidth(cloudStripWidth(element.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * Where the strip sits in a pane: below the pane's title row, so the pane's own split and close
 * buttons stay visible and clickable while it shows (RA-1). The pane and its fixture share it.
 */
export function CloudStripLayer({ children }: { children: React.ReactNode }): React.JSX.Element {
  // A pane-top banner (RA-11): the pane reserves its height and the terminal refits below it, so
  // no row sits under the strip. The spacer keeps it below a chromeless pane's title-row buttons.
  const ref = useReservePaneTopSpace()
  return (
    <div ref={ref} data-cloud-strip-layer className="pane-top-banner">
      <div
        aria-hidden
        className="pointer-events-none h-[var(--orca-pane-title-height,24px)] [.pane[data-has-title]_&]:hidden"
      />
      {children}
    </div>
  )
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
  tiny: 'grid-cols-[16px_minmax(0,1fr)_200px]',
  compact: 'grid-cols-[16px_minmax(0,1fr)_auto]'
}

export function CloudAgentSignInStrip({
  model,
  prompt,
  width: initialWidth = 'wide',
  actions
}: {
  model: CloudStripModel
  prompt: string | null
  /** The first render's class; after that the strip follows its own live width. */
  width?: CloudStripWidth
  actions: CloudStripActions
}): React.JSX.Element {
  const sectionRef = useRef<HTMLElement | null>(null)
  const width = useLiveStripWidth(sectionRef, initialWidth)
  const compact = width === 'compact'
  const t = useTranslate()
  const titleId = React.useId()
  const detailId = React.useId()
  const [code, setCode] = useState('')
  const primary = model.primary
  return (
    <section
      ref={sectionRef}
      data-strip-width={width}
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
          {compact ? (model.compactTitle ?? model.title) : model.title}
        </span>
        {/* Below 360 px the detail leaves the line but stays the region's description. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              id={detailId}
              className={cn(
                'truncate text-xs leading-4 text-muted-foreground',
                compact && 'sr-only'
              )}
            >
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
              aria-label={
                model.paste.secretLabel ?? t('agentSignInStrip.pasteLabel', 'Code from claude.ai')
              }
              type={model.paste.secretLabel ? 'password' : undefined}
              autoComplete={model.paste.secretLabel ? 'off' : undefined}
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
            // The short label still names what it does for a screen reader.
            aria-label={
              (width === 'tiny' || compact) && primary.narrowLabel ? primary.label : undefined
            }
            size="xs"
            variant={model.status === 'error' ? 'outline' : 'default'}
            aria-busy={primary.busy || undefined}
            aria-disabled={primary.busy || undefined}
            onClick={() => (primary.busy ? undefined : actions.primary(primary.action))}
          >
            {(width === 'tiny' || compact) && primary.narrowLabel
              ? primary.narrowLabel
              : primary.label}
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
        {/* Renew and Restart are the whole action and the strip leaves on its own; Escape still cancels. */}
        {!model.dismiss &&
        (model.status === 'done' ||
          primary?.action.kind === 'renew' ||
          primary?.action.kind === 'restart') ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={model.dismiss ?? t('agentSignInStrip.cancel', 'Cancel sign-in (Esc)')}
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
