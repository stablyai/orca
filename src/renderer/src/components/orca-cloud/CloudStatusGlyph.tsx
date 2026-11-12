import React, { useId } from 'react'
import { cn } from '@/lib/utils'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'

/** A cloud workspace's state as the glyph shows it: the dot's vocabulary plus two transitions. */
export type CloudGlyphState = CloudDotState | 'goingToSleep' | 'restarting'

/**
 * Status is the colour of the whole cloud (Neil's pick, option A): every state fills the cloud
 * with a fine dot texture tinted by state; no badge and no shape change. Archived alone is a hollow
 * dashed outline (option B's), and a state not yet known is a paler fill with a dotted edge.
 * The state is also named in the row and in the accessible label, so colour is never the only signal.
 */
type GlyphShape = {
  fill: 'full' | 'none'
  outline: 'solid' | 'dashed' | 'dotted'
  /** Text colour, so the outline, fill and texture share it (currentColor). */
  tone: string
  /** A paler fill (the outline keeps full strength, so it stays ≥3:1). */
  faint?: boolean
}

// Contrast ≥3:1 against the sidebar, row hover and selected backgrounds, light and dark. Light
// warning is amber nudged toward the foreground (plain amber is 2.4:1 on the selected row).
const SUCCESS = 'text-status-success'
const WARNING =
  'text-[color-mix(in_srgb,var(--status-warning)_85%,var(--foreground))] dark:text-status-warning'
const DESTRUCTIVE = 'text-destructive'
const MUTED = 'text-muted-foreground'
const ACCENT = 'text-blue-600 dark:text-blue-400'

export const CLOUD_GLYPH_SHAPE: Record<CloudGlyphState, GlyphShape> = {
  running: { fill: 'full', outline: 'solid', tone: SUCCESS },
  waking: { fill: 'full', outline: 'solid', tone: ACCENT },
  starting: { fill: 'full', outline: 'solid', tone: ACCENT },
  restarting: { fill: 'full', outline: 'solid', tone: ACCENT },
  goingToSleep: { fill: 'full', outline: 'solid', tone: MUTED },
  sleeping: { fill: 'full', outline: 'solid', tone: MUTED },
  archived: { fill: 'none', outline: 'dashed', tone: MUTED },
  unresponsive: { fill: 'full', outline: 'solid', tone: WARNING },
  failed: { fill: 'full', outline: 'solid', tone: DESTRUCTIVE },
  wakeFailed: { fill: 'full', outline: 'solid', tone: DESTRUCTIVE },
  unknown: { fill: 'full', outline: 'dotted', tone: MUTED, faint: true }
}

// Lucide's cloud, so the glyph keeps the shape every other surface uses.
const CLOUD_PATH = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'
const DASH: Record<GlyphShape['outline'], string | undefined> = {
  solid: undefined,
  dashed: '3.2 2.4',
  dotted: '0.1 2.6'
}

const SIZE = { 12: 'size-3', 14: 'size-3.5', 16: 'size-4' } as const

/**
 * The Orca Cloud glyph with its state in the cloud itself (no corner badge). The filled area is a
 * fine dot grid on 2x+ screens; at 1x a 12–16 px glyph has no room for a readable grid, so it is a
 * solid, slightly lighter fill there.
 */
export function CloudStatusGlyph({
  state,
  size = 12,
  className
}: {
  state: CloudGlyphState
  size?: 12 | 14 | 16
  className?: string
}): React.JSX.Element {
  const shape = CLOUD_GLYPH_SHAPE[state]
  const id = useId().replace(/:/g, '')
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-cloud-glyph-state={state}
      className={cn('shrink-0', SIZE[size], shape.tone, className)}
    >
      {shape.fill === 'full' ? (
        <>
          <defs>
            <clipPath id={`${id}-cloud`}>
              <path d={CLOUD_PATH} />
            </clipPath>
            <pattern id={`${id}-grain`} width="2.4" height="2.4" patternUnits="userSpaceOnUse">
              <circle cx="1.2" cy="1.2" r="0.75" fill="currentColor" />
            </pattern>
          </defs>
          <g clipPath={`url(#${id}-cloud)`}>
            {/* 1x: solid. 2x+: a light wash under a dot grid, so the fill reads as texture. */}
            <rect
              width="24"
              height="24"
              fill="currentColor"
              className={
                shape.faint
                  ? 'opacity-20 [@media(min-resolution:2dppx)]:opacity-10'
                  : 'opacity-55 [@media(min-resolution:2dppx)]:opacity-25'
              }
            />
            <rect
              width="24"
              height="24"
              fill={`url(#${id}-grain)`}
              className={cn(
                'hidden [@media(min-resolution:2dppx)]:inline',
                shape.faint && 'opacity-45'
              )}
            />
          </g>
        </>
      ) : null}
      <path
        d={CLOUD_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={DASH[shape.outline]}
      />
    </svg>
  )
}
