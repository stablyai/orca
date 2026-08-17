// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AgentMapLayout, AgentMapWorktreeRing } from './agent-map-layout'
import { AgentMapScene } from './AgentMapScene'
import { TooltipProvider } from '@/components/ui/tooltip'

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

function hostWorktree(
  id: string,
  hostKind: 'ssh' | 'remote',
  executionHostId: ExecutionHostId,
  hostLabel: string
): AgentMapWorktreeRing {
  return {
    id,
    worktreeId: id,
    executionHostId,
    hostKind,
    hostLabel,
    name: id,
    workspaceKind: 'worktree',
    x: 120,
    y: 120,
    radius: 48,
    agents: [],
    statusCounts: {
      working: 0,
      blocked: 0,
      waiting: 0,
      done: 0,
      'done-seen': 0,
      idle: 0
    },
    quiet: true
  }
}

describe('AgentMapScene project labels', () => {
  it('renders the configured repository image next to its name', () => {
    const { container } = render(
      <TooltipProvider>
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
            agentLabelScale={1}
            mapScale={0.5}
            heldProjectId={null}
            heldWorktreeId={null}
            selectedPaneKey={null}
            allowAggregation
            showOrchestrationLinks
            recentFlareStatuses={new Map()}
            nodeRefs={{ current: new Map() }}
            onSelectAgent={vi.fn()}
            onAgentKeyDown={vi.fn()}
          />
        </svg>
      </TooltipProvider>
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

  it.each([0.5, 1, 2, 4])(
    'keeps the project label frame aligned with the ring at map scale %s',
    (mapScale) => {
      const labelScale = Math.max(1, 1 / mapScale)
      const { container, unmount } = render(
        <TooltipProvider>
          <svg>
            <AgentMapScene
              layout={LAYOUT}
              zoom={1}
              labelScale={labelScale}
              agentLabelScale={1}
              mapScale={mapScale}
              heldProjectId={null}
              heldWorktreeId={null}
              selectedPaneKey={null}
              allowAggregation
              showOrchestrationLinks
              recentFlareStatuses={new Map()}
              nodeRefs={{ current: new Map() }}
              onSelectAgent={vi.fn()}
              onAgentKeyDown={vi.fn()}
            />
          </svg>
        </TooltipProvider>
      )
      const frame = container.querySelector('.agent-map-project-label-frame')!
      const ring = container.querySelector('.agent-map-project-ring')!
      const frameScreenWidth = Number(frame.getAttribute('width')) * labelScale * mapScale
      const ringScreenDiameter = Number(ring.getAttribute('r')) * 2 * mapScale

      expect(frameScreenWidth).toBe(ringScreenDiameter)
      expect(Number(frame.getAttribute('width'))).toBe(192 * Math.min(1, mapScale))
      unmount()
    }
  )

  it('labels an SSH-backed project ring with its saved host', () => {
    const sshLayout: AgentMapLayout = {
      ...LAYOUT,
      projects: [
        {
          ...LAYOUT.projects[0],
          worktrees: [hostWorktree('worktree-1:openclaw', 'ssh', 'ssh:opaque-target', 'openclaw')]
        }
      ]
    }
    const { container } = render(
      <TooltipProvider>
        <svg>
          <AgentMapScene
            layout={sshLayout}
            zoom={1}
            labelScale={1}
            agentLabelScale={1}
            mapScale={0.5}
            heldProjectId={null}
            heldWorktreeId={null}
            selectedPaneKey={null}
            allowAggregation
            showOrchestrationLinks
            recentFlareStatuses={new Map()}
            nodeRefs={{ current: new Map() }}
            onSelectAgent={vi.fn()}
            onAgentKeyDown={vi.fn()}
          />
        </svg>
      </TooltipProvider>
    )

    const badge = container.querySelector('[data-dashboard-host-badge="ssh"]')
    expect(badge).toHaveAccessibleName('SSH host · openclaw')
    expect(badge).toHaveClass('agent-map-project-host-badge', 'pointer-events-auto')
  })

  it('renders one focusable badge per unique remote host', () => {
    const hostLayout: AgentMapLayout = {
      ...LAYOUT,
      projects: [
        {
          ...LAYOUT.projects[0],
          radius: 20,
          worktrees: [
            hostWorktree('ssh-a', 'ssh', 'ssh:shared', 'alpha'),
            hostWorktree('ssh-a-copy', 'ssh', 'ssh:shared', 'alpha duplicate'),
            hostWorktree('ssh-b', 'ssh', 'ssh:other', 'beta'),
            hostWorktree('remote-a', 'remote', 'runtime:remote', 'gamma')
          ]
        }
      ]
    }
    const { container } = render(
      <TooltipProvider>
        <svg>
          <AgentMapScene
            layout={hostLayout}
            zoom={1}
            labelScale={1}
            agentLabelScale={1}
            mapScale={1}
            heldProjectId={null}
            heldWorktreeId={null}
            selectedPaneKey={null}
            allowAggregation
            showOrchestrationLinks
            recentFlareStatuses={new Map()}
            nodeRefs={{ current: new Map() }}
            onSelectAgent={vi.fn()}
            onAgentKeyDown={vi.fn()}
          />
        </svg>
      </TooltipProvider>
    )
    const badges = container.querySelectorAll('[data-dashboard-host-badge]')

    expect(badges).toHaveLength(3)
    expect([...badges].map((badge) => badge.getAttribute('tabindex'))).toEqual(['0', '0', '0'])
    expect(container.querySelector('.agent-map-project-label-frame')).toHaveAttribute('width', '40')
  })
})
