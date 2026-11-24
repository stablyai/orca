import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'

export function singlePaneLayoutSnapshot(
  leafId: string,
  ptyId?: string,
  title?: string | null
): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ...(ptyId ? { ptyIdsByLeafId: { [leafId]: ptyId } } : {}),
    ...(title ? { titlesByLeafId: { [leafId]: title } } : {})
  }
}
