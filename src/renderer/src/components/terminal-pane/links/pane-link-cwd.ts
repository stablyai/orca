import type { PaneCwdMap } from '../layout/split/resolve-split-cwd'

export function resolvePaneLinkCwd(
  paneCwdMap: PaneCwdMap,
  paneId: number,
  fallbackCwd: string
): string {
  return paneCwdMap.get(paneId)?.cwd ?? fallbackCwd
}
