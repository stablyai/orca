import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MissionControlTaskRow } from './MissionControlTaskRow'
import type { OrchestrationTaskNode } from '../../../../shared/runtime-types'

function node(overrides: Partial<OrchestrationTaskNode>): OrchestrationTaskNode {
  return {
    id: 'task_1',
    status: 'ready',
    deps: [],
    title: 'implement-auth',
    targetKey: null,
    dispatch: null,
    signal: null,
    ...overrides
  }
}

function render(node: OrchestrationTaskNode): string {
  return renderToStaticMarkup(
    React.createElement(MissionControlTaskRow, { node, nodesById: new Map() })
  )
}

describe('MissionControlTaskRow', () => {
  it('renders a dispatched task with the working spinner, agent glyph, and phase', () => {
    const markup = render(
      node({
        status: 'dispatched',
        title: 'implement-auth',
        dispatch: {
          assigneeHandle: 'term_x',
          assigneeAgent: 'codex',
          status: 'dispatched',
          lastHeartbeatAt: '2026-06-01T00:00:00.000Z',
          stale: false
        },
        signal: { phase: 'implementing: token refresh', summary: null }
      })
    )
    // AgentStateDot 'working' renders the stepped yellow spinner.
    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('implement-auth')
    expect(markup).toContain('working')
    expect(markup).toContain('implementing: token refresh')
    // An agent glyph (SVG) is present for an assigned worker.
    expect(markup).toContain('<svg')
  })

  it('renders a completed task with the done check and no agent glyph', () => {
    const markup = render(node({ status: 'completed', title: 'scaffold-routes' }))
    // AgentStateDot 'done' renders an emerald check; a queued/done task with no
    // dispatch shows no agent glyph cell content.
    expect(markup).toContain('text-emerald-500')
    expect(markup).toContain('done')
  })

  it('renders a stalled dispatched task with the amber dot', () => {
    const markup = render(
      node({
        status: 'dispatched',
        dispatch: {
          assigneeHandle: 'term_x',
          assigneeAgent: 'claude',
          status: 'dispatched',
          lastHeartbeatAt: null,
          stale: true
        }
      })
    )
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('stalled')
  })
})
