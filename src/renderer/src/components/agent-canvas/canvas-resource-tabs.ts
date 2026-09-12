import type { Tab } from '../../../../shared/tab-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { toHostSessionTabId } from '../../../../shared/terminal-surface-id'
import type { CanvasNode } from './agent-canvas-document'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export function canvasNodeUsesTab(node: CanvasNode, tab: Tab): boolean {
  if (node.kind === 'browser') {
    return tab.contentType === 'browser' && node.browserTabId === tab.entityId
  }
  if (node.kind !== 'agent' || tab.contentType !== 'terminal') {
    return false
  }
  if (node.agentKey) {
    try {
      const [host, , workspace, key] = JSON.parse(node.agentKey)
      const pane = typeof key === 'string' ? parsePaneKey(key) : null
      return (
        host === (tab.executionHostId ?? null) &&
        workspace === tab.worktreeId &&
        !!pane &&
        toHostSessionTabId(pane.tabId) === toHostSessionTabId(tab.entityId)
      )
    } catch {
      return false
    }
  }
  return node.agentTabId === tab.entityId
}

export function canvasResourceTab(
  node: CanvasNode,
  canvas: Tab,
  tabs: Tab[],
  fallbackHost?: ExecutionHostId
): Tab | undefined {
  return tabs.find(
    (tab) =>
      tab.worktreeId === canvas.worktreeId &&
      (tab.executionHostId ?? fallbackHost) === canvas.executionHostId &&
      canvasNodeUsesTab(node, { ...tab, executionHostId: tab.executionHostId ?? fallbackHost })
  )
}
