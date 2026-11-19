import React, { useLayoutEffect, useRef, useState } from 'react'
import type { StatusPillTone } from './workspace-cleanup-candidate-row-data'
import { StatusPill } from './workspace-cleanup-status-pill'

type GitStatusPill = { label: string; tone: StatusPillTone }

/**
 * How many pills to show, in priority order. Whole pills while they fit with a "+N" chip for the
 * rest; if not even the first fits beside the chip, keep it (truncated) so the warning never hides.
 */
export function countWholeGitStatusPills(
  widths: readonly number[],
  available: number,
  overflowChipWidth: number,
  gap: number
): number {
  const total = widths.length
  if (total === 0) {
    return 0
  }
  const allWidth = widths.reduce((sum, width) => sum + width, 0) + gap * (total - 1)
  if (allWidth <= available) {
    return total
  }
  for (let shown = total - 1; shown >= 1; shown -= 1) {
    const shownWidth = widths.slice(0, shown).reduce((sum, width) => sum + width, 0)
    if (shownWidth + gap * shown + overflowChipWidth <= available) {
      return shown
    }
  }
  return 1
}

/**
 * Git pills in priority order. The status list's tooltip on the enclosing slot lists every label,
 * so "+N" needs no tooltip of its own; it is focusable so keyboard users reach the same content.
 */
export function WorkspaceCleanupGitStatusPills({
  statuses
}: {
  statuses: readonly GitStatusPill[]
}): React.JSX.Element {
  const groupRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [visibleCount, setVisibleCount] = useState(statuses.length)
  const [resizeTick, setResizeTick] = useState(0)

  useLayoutEffect(() => {
    const group = groupRef.current
    const measure = measureRef.current
    if (!group || !measure) {
      return
    }
    const measured = Array.from(measure.children).map(
      (child) => child.getBoundingClientRect().width
    )
    const widths = measured.slice(0, statuses.length)
    const chipWidth = measured[statuses.length] ?? 0
    const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0
    const next = countWholeGitStatusPills(widths, group.clientWidth, chipWidth, gap)
    if (next !== visibleCount) {
      setVisibleCount(next)
    }
  }, [statuses, visibleCount, resizeTick])

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => setResizeTick((tick) => tick + 1))
    observer.observe(group)
    return () => observer.disconnect()
  }, [])

  const shown = statuses.slice(0, Math.min(visibleCount, statuses.length))
  const hidden = statuses.slice(shown.length)
  return (
    <span
      ref={groupRef}
      className="relative flex h-5 min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
    >
      {shown.map((status, index) => (
        <StatusPill
          key={status.label}
          tone={status.tone}
          className={index === 0 ? 'min-w-16 shrink' : 'shrink-0'}
        >
          {status.label}
        </StatusPill>
      ))}
      {hidden.length > 0 ? (
        <span
          tabIndex={0}
          aria-label={hidden.map((status) => status.label).join(' · ')}
          className="shrink-0 rounded-sm text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          +{hidden.length}
        </span>
      ) : null}
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1.5"
      >
        {statuses.map((status) => (
          <StatusPill key={status.label} tone={status.tone}>
            {status.label}
          </StatusPill>
        ))}
        <span className="text-xs">+{statuses.length}</span>
      </span>
    </span>
  )
}
