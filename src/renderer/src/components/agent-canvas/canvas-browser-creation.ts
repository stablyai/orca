import type { AppState } from '@/store/types'
import {
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { findCanvasNodePosition, type CanvasNode } from './agent-canvas-document'
import {
  CANVAS_STORAGE_PREFIX,
  changeCanvasDocument,
  readCanvasDocument
} from './canvas-document-access'

type BrowserCanvasTarget = { scope: string; groupId: string; agentNodeId: string }
type CanvasBrowserState = Pick<AppState, 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'> &
  WorktreeRuntimeOwnerState

export function resolveBrowserCanvasTarget(
  state: CanvasBrowserState,
  worktreeId: string,
  originPaneKey?: string
): BrowserCanvasTarget | null {
  const pane = originPaneKey ? parsePaneKey(originPaneKey) : null
  if (!pane) {
    return null
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const terminal = tabs.find((tab) => tab.contentType === 'terminal' && tab.entityId === pane.tabId)
  if (!terminal) {
    return null
  }
  const executionHostId =
    terminal.executionHostId ?? getExecutionHostIdForWorktree(state, worktreeId)
  const targets: BrowserCanvasTarget[] = []
  for (const tab of tabs) {
    if (tab.contentType !== 'canvas' || tab.executionHostId !== executionHostId) {
      continue
    }
    const scope = JSON.stringify(['workspace-tab', tab.executionHostId, worktreeId, tab.id])
    const { document, error } = readCanvasDocument(CANVAS_STORAGE_PREFIX + scope)
    if (error) {
      throw new Error(error)
    }
    const agent = document.nodes.find((node) => {
      if (node.kind !== 'agent') {
        return false
      }
      if (node.agentKey) {
        try {
          const [host, , workspace, key] = JSON.parse(node.agentKey)
          return (
            host === (tab.executionHostId ?? null) &&
            workspace === worktreeId &&
            key === originPaneKey
          )
        } catch {
          return false
        }
      }
      const leaves = Object.keys(state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId ?? {})
      return node.agentTabId === pane.tabId && leaves.length === 1 && leaves[0] === pane.leafId
    })
    if (!agent) {
      continue
    }
    if (document.nodes.length >= 500 || document.edges.length >= 2000) {
      throw new Error(
        'The agent canvas is full. Remove a card or connection before creating a browser.'
      )
    }
    targets.push({ scope, groupId: tab.groupId, agentNodeId: agent.id })
  }
  if (targets.length > 1) {
    throw new Error(
      'This agent belongs to multiple canvases. Keep it in one canvas before creating a browser.'
    )
  }
  return targets[0] ?? null
}

export function addCreatedBrowserToCanvas(
  target: BrowserCanvasTarget,
  browserTabId: string,
  url: string
): void {
  changeCanvasDocument(target.scope, (document) => {
    if (document.nodes.some((node) => node.browserTabId === browserTabId)) {
      return document
    }
    const agent = document.nodes.find((node) => node.id === target.agentNodeId)
    if (!agent) {
      throw new Error('The agent was removed from the canvas before the browser was added.')
    }
    const size = { width: 720, height: 520 }
    const browser: CanvasNode = {
      id: crypto.randomUUID(),
      kind: 'browser',
      browserTabId,
      title: 'Browser',
      content: url,
      ...size,
      position: findCanvasNodePosition(
        document.nodes,
        { x: agent.position.x + agent.width + 64, y: agent.position.y },
        size
      )
    }
    return {
      ...document,
      nodes: [...document.nodes, browser],
      edges: [
        ...document.edges,
        { id: crypto.randomUUID(), source: browser.id, target: agent.id, kind: 'browser-control' }
      ]
    }
  })
}
