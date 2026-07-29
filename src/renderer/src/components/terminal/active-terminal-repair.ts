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

// Resolve which terminal tab to open after a project/agent is selected, or null if no repair is needed.
export function resolveRepairedActiveTerminalTabId(args: {
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
  rememberedTabId: string | null | undefined
  tabs: TerminalTab[]
}): string | null {
  if (!shouldRepairActiveTerminalTab(args)) {
    return null
  }
  if (args.rememberedTabId && args.tabs.some((tab) => tab.id === args.rememberedTabId)) {
    return args.rememberedTabId
  }
  return args.tabs[0].id
}
