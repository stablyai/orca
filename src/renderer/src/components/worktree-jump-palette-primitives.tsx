import { useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import type { PaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import type { MatchRange, PaletteSearchResult } from '@/lib/worktree-palette-search'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Worktree } from '../../../shared/worktree/types'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'

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
  matchRanges
}: {
  text: string
  matchRanges?: readonly MatchRange[] | null
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
        <span className="font-semibold text-foreground" key={`${start}-${end}`}>
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

export function PaletteOpenTabPrimaryLine({
  title,
  titleRanges,
  secondaryText,
  secondaryRanges,
  worktreeName,
  worktreeRanges,
  sessionAge,
  leadingBadges
}: {
  title: string
  titleRanges: readonly MatchRange[]
  secondaryText: string
  secondaryRanges: readonly MatchRange[]
  worktreeName: string
  worktreeRanges: readonly MatchRange[]
  sessionAge?: string
  leadingBadges?: React.ReactNode
}): React.JSX.Element {
  const showSecondary = secondaryText.trim().length > 0
  const showWorktree = worktreeName.trim().length > 0

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <span
        data-slot="palette-open-tab-title"
        className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground"
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
        <>
          <span className="shrink-0 text-muted-foreground/45">·</span>
          <span className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/92">
            <HighlightedText text={secondaryText} matchRanges={secondaryRanges} />
          </span>
        </>
      ) : null}
      {showWorktree ? (
        <>
          <span className="shrink-0 text-muted-foreground/45">·</span>
          <span
            data-slot="palette-open-tab-worktree"
            className="min-w-0 truncate text-[12px] font-medium text-muted-foreground/92"
          >
            <HighlightedText text={worktreeName} matchRanges={worktreeRanges} />
          </span>
        </>
      ) : null}
    </div>
  )
}

function resolveOpenTabWorktreeRailTooltip({
  isBranch,
  truncated,
  name
}: {
  isBranch: boolean
  truncated: boolean
  name: string
}): string {
  if (truncated) {
    return name
  }
  return isBranch
    ? translate('auto.components.WorktreeJumpPalette.paletteOpenTabBranch', 'Branch name')
    : translate('auto.components.WorktreeJumpPalette.paletteOpenTabWorkspace', 'Workspace name')
}

export function PaletteOpenTabWorktreeRailLabel({
  name,
  matchRanges,
  worktree,
  className,
  slot = 'palette-open-tab-worktree'
}: {
  name: string
  matchRanges: readonly MatchRange[]
  worktree?: Pick<Worktree, 'branch'> | null
  className?: string
  slot?: string
}): React.JSX.Element | null {
  const [truncated, setTruncated] = useState(false)
  const labelRef = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    const node = labelRef.current
    if (!node) {
      setTruncated(false)
      return
    }
    const updateTruncated = (): void => {
      const next = node.scrollWidth > node.clientWidth
      setTruncated((current) => (current === next ? current : next))
    }
    updateTruncated()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(updateTruncated)
    observer.observe(node)
    return () => observer.disconnect()
  }, [name])
  if (name.trim().length === 0) {
    return null
  }
  const isBranch = worktree != null && name === resolveWorktreeBranchLabel(worktree)
  const tooltip = resolveOpenTabWorktreeRailTooltip({ isBranch, truncated, name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={labelRef} data-slot={slot} tabIndex={-1} className={className}>
          <HighlightedText text={name} matchRanges={matchRanges} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-80 break-all">
        {tooltip}
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
