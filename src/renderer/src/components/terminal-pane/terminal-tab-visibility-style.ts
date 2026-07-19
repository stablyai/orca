import type { CSSProperties } from 'react'

export type TerminalTabSurfaceVisibility = {
  isVisible: boolean
  isWorktreeActive: boolean
  shouldMeasureHiddenStartup: boolean
}

export type TerminalTabSurfaceStyle = Pick<CSSProperties, 'display' | 'opacity' | 'pointerEvents'>

/**
 * Decide how a mounted terminal surface is hidden.
 *
 * Why: `display: none` zeroes xterm's viewport before hide/resume effects can
 * capture scroll, so returning to the tab jumps to the top. Intra-worktree tab
 * switches (and startup measurement) keep layout via opacity instead; only a
 * fully inactive worktree surface uses `display: none`.
 */
export function resolveTerminalTabSurfaceStyle({
  isVisible,
  isWorktreeActive,
  shouldMeasureHiddenStartup
}: TerminalTabSurfaceVisibility): TerminalTabSurfaceStyle {
  if (isVisible) {
    return { display: 'flex' }
  }
  if (shouldMeasureHiddenStartup || isWorktreeActive) {
    return { display: 'flex', opacity: 0, pointerEvents: 'none' }
  }
  return { display: 'none', pointerEvents: 'none' }
}

export function isTerminalTabSurfaceLaidOut(style: TerminalTabSurfaceStyle): boolean {
  return style.display === 'flex'
}