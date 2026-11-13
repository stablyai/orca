import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

export type ParkableTerminalTabModel = Pick<TerminalTab, 'id' | 'ptyId'>

export function reconcileParkedWatcherPtyIds(args: {
  currentTabPtyId: string | null
  entryTabPtyId: string | null
  paneIdByPtyId: ReadonlyMap<string, number>
  expectedPtyIds: ReadonlySet<string>
}): {
  restartAll: boolean
  addedPtyIds: string[]
  retainedPtyIds: string[]
  retiredPaneIds: number[]
} {
  const retainedPtyIds = Array.from(args.paneIdByPtyId.keys()).filter((ptyId) =>
    args.expectedPtyIds.has(ptyId)
  )
  return {
    restartAll: args.entryTabPtyId !== args.currentTabPtyId,
    addedPtyIds: Array.from(args.expectedPtyIds).filter((ptyId) => !args.paneIdByPtyId.has(ptyId)),
    retainedPtyIds,
    retiredPaneIds: Array.from(args.paneIdByPtyId)
      .filter(([ptyId]) => !args.expectedPtyIds.has(ptyId))
      .map(([, paneId]) => paneId)
  }
}
