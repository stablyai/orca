import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { bindCanvasAgentNodes, indexCanvasAgents } from './canvas-agent-bindings'
import { canvasAgentKey, emptyCanvasDocument } from './agent-canvas-document'

const card = {
  paneKey: 'tab:leaf',
  tabId: 'tab',
  worktreeId: 'worktree',
  repoId: 'repo',
  executionHostId: 'local'
} as DashboardCard
describe('canvas agent bindings', () => {
  it('binds a newly launched terminal to one exact pane and never follows a sibling', () => {
    const document = {
      ...emptyCanvasDocument(),
      nodes: [
        {
          id: 'node',
          kind: 'agent' as const,
          agentTabId: 'tab',
          title: 'Codex',
          content: '',
          position: { x: 0, y: 0 },
          width: 480,
          height: 360
        }
      ]
    }
    const bound = bindCanvasAgentNodes(document, indexCanvasAgents([card]))
    expect(bound.nodes[0].agentKey).toBe(canvasAgentKey(card))
    const sibling = { ...card, paneKey: 'tab:other' }
    expect(bindCanvasAgentNodes(bound, indexCanvasAgents([sibling]))).toBe(bound)
    expect(indexCanvasAgents([card, sibling]).has('tab')).toBe(false)
    expect(bindCanvasAgentNodes(document, indexCanvasAgents([card, sibling]))).toBe(document)
  })
})
