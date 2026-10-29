import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export function shouldRepairActiveTerminalTab(args: {
  activeTabType: WorkspaceVisibleTabType
  activeTabId: string | null
  tabs: TerminalTab[]
}): boolean {
  return (
    args.activeTabType === 'terminal' &&
    args.tabs.length > 0 &&
    (!args.activeTabId || !args.tabs.some((tab) => tab.id === args.activeTabId))
  )
}

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
