import React from 'react'
import { FolderOpen } from 'lucide-react'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { splitPathHeadForElision } from '@/lib/path-head-elision'

/** Identity mark shared by the field and every row, so a project reads the same in both. */
export function ProjectOptionMark({
  option
}: {
  option: NewWorkspaceProjectOption
}): React.JSX.Element {
  return option.kind === 'project-group' ? (
    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <RepoBadgeMark color={option.badgeColor} />
  )
}

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
  // Translate UTF-16 offsets while rendering code points so astral glyphs do not shift marks.
  let codeUnit = 0
  return (
    <span className={cn('min-w-0 truncate', className)}>
      {[...text].map((char) => {
        const index = codeUnit
        codeUnit += char.length
        return marks.has(index) ? (
          <mark
            key={`${index}-${char}`}
            className="bg-transparent p-0 font-semibold text-foreground underline decoration-ring underline-offset-2"
          >
            {char}
          </mark>
        ) : (
          char
        )
      })}
    </span>
  )
}

/** Keep the final two path segments when narrowing so sibling projects remain distinguishable. */
export function ProjectOptionDetail({
  detail,
  hits,
  className
}: {
  detail: string
  hits?: readonly number[]
  className?: string
}): React.JSX.Element {
  const ranges = hits?.map((index) => ({ start: index, end: index + 1 }))
  const split = splitPathHeadForElision(detail, ranges)
  if (!split) {
    return (
      <span className={cn('min-w-0 truncate', className)} title={detail}>
        {hits ? <MatchedText text={detail} hits={hits} /> : detail}
      </span>
    )
  }
  return (
    <span className={cn('flex min-w-0 items-baseline overflow-hidden', className)} title={detail}>
      <span className="min-w-0 shrink-[999] truncate">{split.head}</span>
      <span className="min-w-0 shrink truncate">
        {split.tailRanges.length > 0 ? (
          <MatchedText text={split.tail} hits={split.tailRanges.map((range) => range.start)} />
        ) : (
          split.tail
        )}
      </span>
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
        // Baseline-align mixed text sizes so name/detail read as one line.
        'flex h-8 cursor-default items-baseline gap-2 rounded-sm px-2 text-sm',
        armed && 'bg-accent text-accent-foreground',
        current && !armed && 'bg-accent/60'
      )}
    >
      <span className="flex h-8 shrink-0 items-center">
        <ProjectOptionMark option={option} />
      </span>
      {/* Reserve up to half the row for the name so deep paths cannot squeeze it away. */}
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
