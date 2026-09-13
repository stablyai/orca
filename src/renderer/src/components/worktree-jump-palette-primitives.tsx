import React from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import type { PaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import type { MatchRange, PaletteSearchResult } from '@/lib/worktree-palette-search'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { splitPathHeadForElision } from '@/lib/path-head-elision'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'

const NO_SECONDARY_MATCHES: readonly { text: string; ranges: readonly MatchRange[] }[] = []

export function PaletteRowShortcutBadge({
  index,
  modifierKeys
}: {
  index: number | undefined
  modifierKeys: readonly string[]
}): React.JSX.Element | null {
  if (index === undefined || modifierKeys.length === 0) {
    return null
  }
  return (
    <ShortcutKeyCombo
      keys={[...modifierKeys, String(index + 1)]}
      className="inline-flex gap-0.5"
      keyCapClassName="min-w-4 border-border/60 bg-background/45 px-1 py-px text-[9px] text-muted-foreground/88 shadow-none"
      separatorClassName="text-[9px] text-muted-foreground/60"
    />
  )
}

export function HighlightedText({
  text,
  matchRanges,
  highlightClassName = 'font-semibold text-foreground'
}: {
  text: string
  matchRanges?: readonly MatchRange[] | null
  highlightClassName?: string
}): React.JSX.Element {
  const ranges = (matchRanges ?? []).filter(
    (range) => range.start < range.end && range.start < text.length
  )
  if (ranges.length === 0) {
    return <>{text}</>
  }
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(cursor, range.start)
    const end = Math.min(text.length, Math.max(start, range.end))
    if (start > cursor) {
      parts.push(text.slice(cursor, start))
    }
    if (end > start) {
      parts.push(
        <span className={highlightClassName} key={`${start}-${end}`}>
          {text.slice(start, end)}
        </span>
      )
      cursor = end
    }
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return <>{parts}</>
}

function PaletteOpenTabSecondaryText({
  text,
  ranges,
  elidePathHead
}: {
  text: string
  ranges: readonly MatchRange[]
  elidePathHead: boolean
}): React.JSX.Element {
  const split = elidePathHead ? splitPathHeadForElision(text, ranges) : null
  const content = split ? (
    <span
      data-slot="palette-open-tab-secondary"
      className="flex min-w-0 items-baseline overflow-hidden font-mono text-[11px] text-muted-foreground/80"
    >
      <span className="min-w-0 shrink-[999] truncate">{split.head}</span>
      <span className="min-w-0 shrink truncate">
        <HighlightedText text={split.tail} matchRanges={split.tailRanges} />
      </span>
    </span>
  ) : (
    <span
      data-slot="palette-open-tab-secondary"
      className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80"
    >
      <HighlightedText text={text} matchRanges={ranges} />
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-96 break-all">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

export function PaletteOpenTabPrimaryLine({
  title,
  titleRanges,
  secondaryText,
  secondaryRanges,
  secondaryMatches = NO_SECONDARY_MATCHES,
  elideSecondaryPathHead = false,
  sessionAge,
  leadingBadges
}: {
  title: string
  titleRanges: readonly MatchRange[]
  secondaryText: string
  secondaryRanges: readonly MatchRange[]
  secondaryMatches?: readonly { text: string; ranges: readonly MatchRange[] }[]
  elideSecondaryPathHead?: boolean
  sessionAge?: string
  leadingBadges?: React.ReactNode
}): React.JSX.Element {
  const showSecondary = secondaryText.trim().length > 0
  const additionalSecondaryMatches = secondaryMatches.filter(
    (match) => match.text && match.text !== secondaryText
  )

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <span
        data-slot="palette-open-tab-title"
        className={cn(
          'truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground',
          showSecondary ? 'max-w-[62%] shrink-0' : 'min-w-0'
        )}
      >
        <HighlightedText text={title} matchRanges={titleRanges} />
      </span>
      {sessionAge ? (
        <span
          aria-label={translate(
            'auto.components.WorktreeJumpPalette.lastActiveTime',
            'Last active {{value0}} ago',
            { value0: sessionAge }
          )}
          className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70"
        >
          {sessionAge}
        </span>
      ) : null}
      {leadingBadges}
      {showSecondary ? (
        <PaletteOpenTabSecondaryText
          text={secondaryText}
          ranges={secondaryRanges}
          elidePathHead={elideSecondaryPathHead}
        />
      ) : null}
      {additionalSecondaryMatches.length ? (
        <>
          {/* Tab selects the palette filter, so the badge stays out of the tab order and
              reads its matches through the row's own accessible name instead. */}
          <span className="sr-only" data-slot="palette-open-tab-extra-matches">
            {additionalSecondaryMatches.map((match) => match.text).join(', ')}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-hidden
                tabIndex={-1}
                className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88"
              >
                +{additionalSecondaryMatches.length}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} align="start" className="max-w-96 space-y-1">
              {additionalSecondaryMatches.map((match) => (
                <div className="break-all" key={match.text}>
                  <HighlightedText
                    text={match.text}
                    matchRanges={match.ranges}
                    highlightClassName="font-semibold text-inherit"
                  />
                </div>
              ))}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
    </div>
  )
}

export function PaletteLocationChip({
  repoName,
  repoRanges,
  repoColor,
  worktreeName,
  worktreeRanges,
  className
}: {
  repoName: string
  repoRanges: readonly MatchRange[]
  repoColor?: string
  worktreeName: string
  worktreeRanges: readonly MatchRange[]
  className?: string
}): React.JSX.Element | null {
  const showRepo = repoName.trim().length > 0
  const repeatedName = showRepo && worktreeName === repoName
  const showWorktree = worktreeName.trim().length > 0 && !repeatedName
  if (!showRepo && !showWorktree) {
    return null
  }
  const repoMatchRanges = repeatedName
    ? [...repoRanges, ...worktreeRanges].sort((left, right) => left.start - right.start)
    : repoRanges
  const label = [showRepo ? repoName : '', showWorktree ? worktreeName : '']
    .filter(Boolean)
    .join(' · ')
  const chip = (
    <span
      data-slot="palette-location-chip"
      className={cn(
        'inline-flex min-w-0 max-w-[260px] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground',
        className
      )}
    >
      {showRepo ? (
        <>
          <RepoBadgeMark color={repoColor} />
          <span
            className={cn('min-w-0 truncate', showWorktree && 'min-w-[3ch] max-w-[55%]')}
            data-slot="palette-location-repo"
          >
            <HighlightedText text={repoName} matchRanges={repoMatchRanges} />
          </span>
        </>
      ) : null}
      {showRepo && showWorktree ? (
        <span aria-hidden className="shrink-0 text-muted-foreground/50">
          ·
        </span>
      ) : null}
      {showWorktree ? (
        <span
          data-slot="palette-open-tab-worktree"
          className="min-w-[3ch] truncate font-medium text-muted-foreground"
        >
          <HighlightedText text={worktreeName} matchRanges={worktreeRanges} />
        </span>
      ) : null}
    </span>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-96 break-all">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function PaletteState({
  title,
  subtitle
}: {
  title: string
  subtitle: string
}): React.JSX.Element {
  return (
    <div className="px-5 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
    </div>
  )
}

export function FooterKey({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="rounded-full border border-border/60 bg-muted/35 px-2 py-0.5 text-[10px] font-medium text-foreground/85">
      {children}
    </span>
  )
}

export function PaletteHostBadgeChip({
  badge
}: {
  badge: PaletteHostBadge | null
}): React.JSX.Element | null {
  if (!badge) {
    return null
  }
  return (
    <span
      aria-label={translate(
        'auto.components.WorktreeJumpPalette.paletteHostBadge',
        'Host: {{value0}}',
        { value0: badge.label }
      )}
      className="max-w-[140px] truncate rounded-[6px] border border-border/60 bg-background px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88"
    >
      {badge.label}
    </span>
  )
}

export function getPaletteSupportingTextLabel(
  labelKind: NonNullable<PaletteSearchResult['supportingText']>['labelKind']
): string {
  switch (labelKind) {
    case 'comment':
      return translate('worktreeJumpPalette.matchLabel.comment', 'Comment')
    case 'issue':
      return translate('worktreeJumpPalette.matchLabel.issue', 'Issue')
    case 'port':
      return translate('worktreeJumpPalette.matchLabel.port', 'Port')
    case 'pr':
      return translate('worktreeJumpPalette.matchLabel.pr', 'PR')
    case 'mr':
      return translate('worktreeJumpPalette.matchLabel.mr', 'MR')
    case 'task':
      return translate('worktreeJumpPalette.matchLabel.task', 'Task')
    case 'automation':
      return translate('worktreeJumpPalette.matchLabel.automation', 'Automation')
  }
}
