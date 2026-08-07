// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMapLayout } from './agent-map-layout'
import { AgentMapScene } from './AgentMapScene'

const LAYOUT: AgentMapLayout = {
  projects: [
    {
      id: 'repo-1',
      name: 'Orca',
      x: 120,
      y: 120,
      radius: 96,
      worktrees: [],
      agentCount: 1
    }
  ],
  width: 240,
  height: 240,
  topologyKey: 'repo-1'
}

describe('AgentMapScene project labels', () => {
  it('renders the configured repository image next to its name', () => {
    const { container } = render(
      <svg>
        <AgentMapScene
          layout={LAYOUT}
          repoIconsByRepoId={{
            'repo-1': {
              type: 'image',
              src: 'data:image/png;base64,AAAA',
              source: 'upload'
            }
          }}
          zoom={1}
          labelScale={1}
          mapScale={0.5}
          selectedPaneKey={null}
          allowAggregation
          nodeRefs={{ current: new Map() }}
          onSelectAgent={vi.fn()}
          onAgentKeyDown={vi.fn()}
        />
      </svg>
    )

    const label = container.querySelector('.agent-map-project-label')!
    expect(label).toHaveTextContent('ORCA')
    expect(label).toHaveClass('agent-map-project-label')
    expect(label.querySelector('.agent-map-project-name')).toHaveTextContent('ORCA')
    expect(label.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA')
    expect(label.firstElementChild?.querySelector('img')).toBeInTheDocument()
    expect(container.querySelector('.agent-map-project-label-frame')).toHaveAttribute('x', '-48')
    expect(container.querySelector('.agent-map-project-label-frame')).toHaveAttribute('width', '96')
  })
})
