import React, { useLayoutEffect, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { StatusPillTone } from './workspace-cleanup-candidate-row-data'
import { StatusPill } from './workspace-cleanup-status-pill'

type GitStatusPill = { label: string; tone: StatusPillTone }

const DEFAULT_OVERFLOW_CHIP_WIDTH = 28

/** Largest prefix of pills that fits whole, with the "+N" chip when some are left out. */
export function countWholeGitStatusPills(
  widths: readonly number[],
  available: number,
  overflowChipWidth: number,
  gap: number
): number {
  const total = widths.length
  for (let shown = total; shown >= 0; shown -= 1) {
    if (shown === total) {
      const needed = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(total - 1, 0)
      if (needed <= available) {
        return shown
      }
      continue
    }
    const shownWidth = widths.slice(0, shown).reduce((sum, width) => sum + width, 0)
    const needed = shownWidth + gap * shown + overflowChipWidth
    if (needed <= available) {
      return shown
    }
  }
  return 0
}

/**
 * Git pills in priority order: as many whole pills as fit, the rest collapsed into "+N" whose
 * tooltip lists them. A pill is never cut off.
 */
export function WorkspaceCleanupGitStatusPills({
  statuses
}: {
  statuses: readonly GitStatusPill[]
}): React.JSX.Element {
  const groupRef = useRef<HTMLSpanElement>(null)
  const widthsRef = useRef(new Map<string, number>())
  const chipWidthRef = useRef(DEFAULT_OVERFLOW_CHIP_WIDTH)
  const [visibleCount, setVisibleCount] = useState(statuses.length)
  const [resizeTick, setResizeTick] = useState(0)

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) {
      return
    }
    const shown = statuses.slice(0, Math.min(visibleCount, statuses.length))
    Array.from(group.children).forEach((child, index) => {
      const pill = shown[index]
      if (pill !== undefined) {
        widthsRef.current.set(pill.label, child.getBoundingClientRect().width)
      } else {
        chipWidthRef.current = child.getBoundingClientRect().width
      }
    })
    const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0
    const widths = statuses.map((status) => widthsRef.current.get(status.label) ?? 0)
    const next = countWholeGitStatusPills(widths, group.clientWidth, chipWidthRef.current, gap)
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
    <span ref={groupRef} className="flex h-5 min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      {shown.map((status) => (
        <StatusPill key={status.label} tone={status.tone} className="shrink-0">
          {status.label}
        </StatusPill>
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 text-xs text-muted-foreground">+{hidden.length}</span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {hidden.map((status) => status.label).join(' · ')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}
