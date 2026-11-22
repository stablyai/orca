import React, { useLayoutEffect, useRef, useState, useEffectEvent } from 'react'
import { cn } from '@/lib/class-names'
import type { StatusPillTone } from './workspace-cleanup-candidate-row-data'
import { getStatusPillToneClassName, StatusPill } from './workspace-cleanup-status-pill'

type GitStatusPill = { label: string; tone: StatusPillTone }

/** The hidden statuses' most severe tone, so a folded warning still shows on the +N chip. */
export function getMostSevereGitStatusTone(
  statuses: readonly { tone: StatusPillTone }[]
): StatusPillTone | null {
  if (statuses.some((status) => status.tone === 'destructive')) {
    return 'destructive'
  }
  return statuses.some((status) => status.tone === 'review') ? 'review' : null
}

/** Shared by the real chip and the hidden measurer, which uses the widest (tinted) form. */
function getOverflowChipClassName(tone: StatusPillTone | null): string | undefined {
  return tone
    ? cn(
        'inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] font-medium',
        getStatusPillToneClassName(tone)
      )
    : 'rounded-sm text-xs text-muted-foreground'
}

/** Narrowest a truncated first pill may get while its ellipsis still reads as one. */
const MIN_TRUNCATED_PILL_WIDTH = 40

/**
 * How many pills to show, in priority order. Whole pills while they fit with a "+N" chip for the
 * rest; if the first fits only truncated, keep it that way down to a readable width, below which
 * every pill collapses into the "+N" chip (its tooltip still lists them all).
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
  return available >= MIN_TRUNCATED_PILL_WIDTH ? 1 : 0
}

/**
 * Git pills in priority order. The status tooltip on the enclosing slot lists every label, so the
 * "+N" chip and a truncated first pill need no tooltip of their own: keyboard focus on either one
 * opens that single tooltip through the slot.
 */
export function WorkspaceCleanupGitStatusPills({
  statuses
}: {
  statuses: readonly GitStatusPill[]
}): React.JSX.Element {
  const groupRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [visibleCount, setVisibleCount] = useState(statuses.length)
  const [firstTruncated, setFirstTruncated] = useState(false)
  const [resizeTick, setResizeTick] = useState(0)
  const labelKey = statuses.map((status) => status.label).join('\n')

  const measure = useEffectEvent(() => {
    const group = groupRef.current
    const measured = measureRef.current
    if (!group || !measured) {
      return
    }
    const children = Array.from(measured.children)
    const widths = children
      .slice(0, statuses.length)
      .map((child) => child.getBoundingClientRect().width)
    const chipWidth = children[statuses.length]?.getBoundingClientRect().width ?? 0
    const gap = Number.parseFloat(getComputedStyle(group).columnGap) || 0
    const next = countWholeGitStatusPills(widths, group.clientWidth, chipWidth, gap)
    setVisibleCount(next)
    const firstPill = group.firstElementChild
    const label = firstPill instanceof HTMLElement ? firstPill.firstElementChild : null
    setFirstTruncated(label instanceof HTMLElement && label.scrollWidth > label.clientWidth)
  })
  useLayoutEffect(() => {
    measure()
  }, [labelKey, visibleCount, resizeTick])

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
  const hiddenTone = getMostSevereGitStatusTone(hidden)
  return (
    <span
      ref={groupRef}
      className="relative flex h-5 min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
    >
      {shown.map((status, index) =>
        index === 0 ? (
          <StatusPill
            key={status.label}
            tone={status.tone}
            tabIndex={firstTruncated ? 0 : undefined}
            className={cn(
              'min-w-[min(2.5rem,100%)] shrink',
              firstTruncated &&
                'rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
            )}
          >
            {status.label}
          </StatusPill>
        ) : (
          <StatusPill key={status.label} tone={status.tone} className="shrink-0">
            {status.label}
          </StatusPill>
        )
      )}
      {hidden.length > 0 ? (
        <span
          tabIndex={0}
          aria-label={hidden.map((status) => status.label).join(' · ')}
          className={cn(
            'shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            getOverflowChipClassName(hiddenTone)
          )}
        >
          +{hidden.length}
        </span>
      ) : null}
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1.5"
      >
        {statuses.map((status, index) => (
          <StatusPill
            key={status.label}
            tone={status.tone}
            className={index === 0 ? 'min-w-[min(2.5rem,100%)]' : undefined}
          >
            {status.label}
          </StatusPill>
        ))}
        <span className={getOverflowChipClassName('review')}>+{statuses.length}</span>
      </span>
    </span>
  )
}
