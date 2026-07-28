import React from 'react'
import { FolderOpen } from 'lucide-react'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { splitDetailForElision } from './project-combobox-matching'

/** Identity mark shared by the field and every row, so a project reads the same in both. */
export function ProjectOptionMark({
  option
}: {
  option: NewWorkspaceProjectOption
}): React.JSX.Element {
  return option.kind === 'project-group' ? (
    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    // Square, matching the mark everywhere else (jump palette, sidebar).
    <RepoBadgeMark color={option.badgeColor} />
  )
}

/** Underlines the matched characters so a fuzzy hit is legible, not mysterious. */
export function MatchedText({
  text,
  hits,
  className
}: {
  text: string
  hits: readonly number[]
  className?: string
}): React.JSX.Element {
  const marks = new Set(hits)
  if (marks.size === 0) {
    return <span className={cn('min-w-0 truncate', className)}>{text}</span>
  }
  return (
    <span className={cn('min-w-0 truncate', className)}>
      {[...text].map((char, index) =>
        marks.has(index) ? (
          <mark
            key={`${index}-${char}`}
            className="bg-transparent p-0 font-semibold text-foreground underline decoration-ring underline-offset-2"
          >
            {char}
          </mark>
        ) : (
          char
        )
      )}
    </span>
  )
}

/**
 * Detail line that keeps its final two path segments when space runs out —
 * `~/dev/…/services/checkout-api` stays distinct from its `-web` sibling, where
 * a plain truncate would render both identically.
 */
export function ProjectOptionDetail({
  detail,
  hits,
  className
}: {
  detail: string
  hits?: readonly number[]
  className?: string
}): React.JSX.Element {
  const split = splitDetailForElision(detail)
  if (!split) {
    return (
      <span className={cn('min-w-0 truncate', className)} title={detail}>
        {hits ? <MatchedText text={detail} hits={hits} /> : detail}
      </span>
    )
  }
  return (
    <span className={cn('flex min-w-0 items-baseline overflow-hidden', className)} title={detail}>
      {/* Head collapses first; the tail only truncates once the head is gone. */}
      <span className="min-w-0 shrink-[999] truncate">{split.head}</span>
      <span className="min-w-0 shrink truncate">/{split.tail}</span>
    </span>
  )
}

export function ProjectOptionRow({
  option,
  nameHits,
  detailHits,
  armed,
  current,
  ambiguous,
  optionId,
  onArm,
  onCommit
}: {
  option: NewWorkspaceProjectOption
  nameHits: readonly number[]
  detailHits: readonly number[]
  armed: boolean
  current: boolean
  ambiguous: boolean
  optionId: string | undefined
  onArm: () => void
  onCommit: () => void
}): React.JSX.Element {
  return (
    <div
      role="option"
      id={optionId}
      aria-selected={armed}
      data-armed={armed || undefined}
      data-current={current ? 'true' : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onArm}
      onClick={onCommit}
      className={cn(
        // Why: `items-baseline` (not `items-center`) — the name and its smaller
        // detail line sit on one baseline, so the two type sizes read as one
        // line rather than two boxes centred against each other.
        'flex h-8 cursor-default items-baseline gap-2 rounded-sm px-2 text-sm',
        armed && 'bg-accent text-accent-foreground',
        current && !armed && 'bg-accent/60'
      )}
    >
      {/* The mark is a dot, not text, so it centres on the row itself. */}
      <span className="flex h-8 shrink-0 items-center">
        <ProjectOptionMark option={option} />
      </span>
      {/* Name keeps up to half the row; the path absorbs the rest so a deep
          path can't squeeze the name down to "chec…". */}
      <MatchedText
        text={option.displayName}
        hits={nameHits}
        className={cn('max-w-[50%] shrink', current && 'font-medium')}
      />
      <ProjectOptionDetail
        detail={option.detail}
        hits={detailHits}
        className={cn(
          'ml-auto min-w-0 flex-1 shrink-[999] justify-end pl-2 text-right text-xs',
          ambiguous ? 'text-foreground/80' : 'text-muted-foreground'
        )}
      />
    </div>
  )
}
