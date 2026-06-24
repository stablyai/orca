import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationRunDag, OrchestrationTaskNode } from '../../../../shared/runtime-types'

vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

import { MissionControlTasksSection } from './MissionControlTasksSection'

function node(
  id: string,
  title: string,
  status: OrchestrationTaskNode['status']
): OrchestrationTaskNode {
  return { id, status, deps: [], title, targetKey: null, dispatch: null, signal: null }
}

function render(dag: OrchestrationRunDag): string {
  return renderToStaticMarkup(React.createElement(MissionControlTasksSection, { dag }))
}

describe('MissionControlTasksSection', () => {
  it('renders one row per task in the DAG', () => {
    const markup = render({
      runId: 'run_1',
      recipe: null,
      truncatedTaskCount: 0,
      tasks: [
        node('t1', 'implement-auth', 'dispatched'),
        node('t2', 'review-auth', 'pending'),
        node('t3', 'scaffold-routes', 'completed')
      ]
    })
    expect(markup).toContain('implement-auth')
    expect(markup).toContain('review-auth')
    expect(markup).toContain('scaffold-routes')
  })

  it('shows the empty state when the run has no tasks yet', () => {
    const markup = render({ runId: 'run_1', recipe: null, truncatedTaskCount: 0, tasks: [] })
    expect(markup).toContain('No tasks yet')
  })

  it('surfaces a truncation note when tasks were capped', () => {
    const markup = render({
      runId: 'run_1',
      recipe: null,
      truncatedTaskCount: 7,
      tasks: [node('t1', 'implement-auth', 'dispatched')]
    })
    expect(markup).toContain('+7 more')
  })
})
