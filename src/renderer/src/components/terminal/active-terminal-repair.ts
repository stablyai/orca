import type { TerminalTab, WorkspaceVisibleTabType } from '../../../../shared/types'

export function shouldRepairActiveTerminalTab(args: {
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
  tabs: TerminalTab[]
}): boolean {
  if (args.activeTabType !== 'terminal') {
    return false
  }
  if (args.tabs.length === 0) {
    return false
  }
  if (args.activeTabId && args.tabs.some((tab) => tab.id === args.activeTabId)) {
    return false
  }
  return true
}
