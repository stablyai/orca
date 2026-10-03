/** @vitest-environment happy-dom */
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompactAgentRow } from '../sidebar/worktree-card-compact-agent-row'
import { TooltipProvider } from '../ui/tooltip'
import DashboardAgentRow from './DashboardAgentRow'
import type { DashboardAgentRow as AgentRow } from './useDashboardData'
import { DashboardAgentChildDisclosure } from './DashboardAgentChildDisclosure'

vi.mock('./use-agent-row-conversation-name', () => ({ useAgentRowConversationName: () => null }))
vi.mock('../sidebar/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

afterEach(cleanup)

const agent: AgentRow = {
  paneKey: 'tab:leaf',
  agentType: 'claude',
  state: 'working',
  startedAt: 60000,
  entry: {
    paneKey: 'tab:leaf',
    state: 'working',
    prompt: 'Review the change',
    updatedAt: 60000,
    stateStartedAt: 60000,
    stateHistory: []
  },
  tab: {
    id: 'tab',
    ptyId: null,
    worktreeId: 'workspace',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('agent child disclosure', () => {
  it('toggles children without activating the surrounding agent or workspace', () => {
    const activate = vi.fn()
    const toggle = vi.fn()
    const pointerDown = vi.fn()
    const keyDown = vi.fn()
    render(
      <div onClick={activate} onPointerDown={pointerDown} onKeyDown={keyDown}>
        <DashboardAgentChildDisclosure
          childAgentCount={2}
          childAgentsExpanded={false}
          onToggleChildAgents={toggle}
          timestamp="5m"
        />
      </div>
    )
    const button = screen.getByRole('button', { name: 'Show 2 child agents' })
    fireEvent.pointerDown(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(activate).not.toHaveBeenCalled()
    expect(pointerDown).not.toHaveBeenCalled()
    expect(keyDown).not.toHaveBeenCalled()
  })

  it('updates the accessible action and retains the timestamp when expanded', () => {
    const toggle = vi.fn()
    const { rerender } = render(
      <DashboardAgentChildDisclosure
        childAgentCount={1}
        childAgentsExpanded={false}
        onToggleChildAgents={toggle}
        timestamp="5m"
      />
    )
    expect(
      screen.getByRole('button', { name: 'Show 1 child agent' }).getAttribute('aria-expanded')
    ).toBe('false')
    rerender(
      <DashboardAgentChildDisclosure
        childAgentCount={1}
        childAgentsExpanded
        onToggleChildAgents={toggle}
        timestamp="5m"
      />
    )
    expect(
      screen.getByRole('button', { name: 'Hide 1 child agent' }).getAttribute('aria-expanded')
    ).toBe('true')
    expect(screen.getByText('5m')).toBeTruthy()
  })

  it('does not offer a disclosure without children or a toggle action', () => {
    const { rerender } = render(
      <DashboardAgentChildDisclosure
        childAgentCount={0}
        childAgentsExpanded={false}
        onToggleChildAgents={vi.fn()}
      />
    )
    expect(screen.queryByRole('button')).toBeNull()
    rerender(<DashboardAgentChildDisclosure childAgentCount={2} childAgentsExpanded={false} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe.each(['compact', 'full'] as const)('%s row disclosure actions', (mode) => {
  it.each([undefined, 'eligible'] as const)(
    'keeps child expansion separate from row actions in %s send mode',
    (sendTargetStatus) => {
      const onActivate = vi.fn(),
        onSendTargetClick = vi.fn(),
        onDismiss = vi.fn(),
        onToggleChildAgents = vi.fn()
      const props = {
        agent,
        now: 120000,
        childAgentCount: 2,
        childAgentsExpanded: false,
        onToggleChildAgents,
        onActivate,
        sendTargetStatus,
        onSendTargetClick
      }
      render(
        <TooltipProvider>
          {mode === 'compact' ? (
            <CompactAgentRow {...props} />
          ) : (
            <DashboardAgentRow {...props} onDismiss={onDismiss} hideExpand />
          )}
        </TooltipProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: 'Show 2 child agents' }))
      expect(onToggleChildAgents).toHaveBeenCalledTimes(1)
      expect(onActivate).not.toHaveBeenCalled()
      expect(onSendTargetClick).not.toHaveBeenCalled()
      expect(onDismiss).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText('Review the change'))
      if (sendTargetStatus) {
        expect(onSendTargetClick).toHaveBeenCalledWith(agent.paneKey)
        expect(onActivate).not.toHaveBeenCalled()
      } else {
        expect(onActivate).toHaveBeenCalledWith(agent.tab.id, agent.paneKey)
        if (mode === 'full') {
          fireEvent.click(screen.getByRole('button', { name: 'Dismiss agent' }))
          expect(onDismiss).toHaveBeenCalledWith(agent.paneKey)
          expect(onActivate).toHaveBeenCalledTimes(1)
        }
      }
    }
  )
})
