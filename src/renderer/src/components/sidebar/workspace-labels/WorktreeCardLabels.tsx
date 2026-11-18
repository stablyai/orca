import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceLabel } from '../../../../../shared/workspace/labels/workspace-labels'
import { countFittingLabels } from './count-fitting-labels'

const CAPSULE_CLASS =
  'inline-flex h-4 items-center rounded-full border px-1.5 text-[10px] leading-none font-medium text-foreground/90'

// Why: overflowed capsules leave the flow but stay measurable, so a wider sidebar can bring them back.
function LabelCapsule({
  label,
  overflowed
}: {
  label: WorkspaceLabel
  overflowed: boolean
}): React.JSX.Element {
  return (
    <span
      data-label-capsule=""
      className={`${CAPSULE_CLASS} max-w-[8rem] shrink-0 ${overflowed ? 'invisible absolute' : ''}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${label.color} 18%, transparent)`,
        borderColor: `color-mix(in srgb, ${label.color} 55%, transparent)`
      }}
    >
      <span className="min-w-0 truncate">{label.name}</span>
    </span>
  )
}

/** Unknown ids (labels this desktop doesn't have) are skipped, never removed. */
export function WorktreeCardLabels({
  labelIds
}: {
  labelIds: readonly string[]
}): React.JSX.Element | null {
  const t = useTranslate()
  const workspaceLabels = useAppStore((s) => s.workspaceLabels)
  const labels = useMemo(() => {
    const byId = new Map(workspaceLabels.map((label) => [label.id, label]))
    return labelIds.flatMap((id) => byId.get(id) ?? [])
  }, [labelIds, workspaceLabels])
  const rowRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(labels.length)
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) {
      return
    }
    const fit = (): void => {
      const widths = Array.from(
        row.querySelectorAll<HTMLElement>('[data-label-capsule]'),
        (capsule) => capsule.offsetWidth
      )
      setVisibleCount(countFittingLabels(widths, row.clientWidth))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(row)
    return () => observer.disconnect()
  }, [labels])
  if (labels.length === 0) {
    return null
  }
  const hidden = labels.slice(visibleCount)
  const hiddenNames = hidden.map((label) => label.name).join(', ')
  return (
    <div
      ref={rowRef}
      className="relative flex min-w-0 items-center gap-1 overflow-hidden"
      data-worktree-card-labels=""
    >
      {labels.map((label, index) => (
        <LabelCapsule key={label.id} label={label} overflowed={index >= visibleCount} />
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`${CAPSULE_CLASS} shrink-0 border-border bg-muted`}
              aria-label={t('workspaceLabels.card.moreLabels', 'More labels: {{names}}', {
                names: hiddenNames
              })}
            >
              +{hidden.length}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{hiddenNames}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
