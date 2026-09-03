import type { LocalhostWorktreeLabelRoute } from '../../../shared/localhost-worktree-labels'
import { getLocalhostWorktreeHostLabel } from '../../../shared/localhost-worktree-labels'
import { getLocalhostWorktreeCssColor } from '../../../shared/localhost-worktree-color'

// Why: port indicators tinted with the favicon's hue let users match a
// sidebar/status-bar port to its browser tab by color alone. Derived from the
// base label, so a rare proxy collision suffix (-2) may shift the tab hue.
export function localhostWorktreeColorForRoute(
  route: LocalhostWorktreeLabelRoute | null
): string | null {
  if (!route) {
    return null
  }
  return getLocalhostWorktreeCssColor(getLocalhostWorktreeHostLabel(route))
}
