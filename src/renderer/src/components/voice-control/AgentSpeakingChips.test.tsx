// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { AgentSpeakingChips } from './AgentSpeakingChips'
import {
  publishVoiceControlAgentActivity,
  publishVoiceControlState,
  resetVoiceControl
} from './voice-control-store'

const { useAppStoreMock } = vi.hoisted(() => ({ useAppStoreMock: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

function mockAgentStatus(byPaneKey: Record<string, { agentType?: string }>): void {
  useAppStoreMock.mockImplementation((selector: (state: unknown) => unknown) =>
    selector({ agentStatusByPaneKey: byPaneKey })
  )
}

afterEach(() => {
  cleanup()
  resetVoiceControl()
})

describe('AgentSpeakingChips', () => {
  it('renders nothing until the session is live with active agents', () => {
    mockAgentStatus({})
    const { container } = render(<AgentSpeakingChips />)
    expect(container).toBeEmptyDOMElement()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
    })
    expect(container).toBeEmptyDOMElement()
  })

  it('labels a pane agent by its roster spoken name, not its provider type', () => {
    mockAgentStatus({ 'tab-1:leaf': { agentType: 'claude' } })
    render(<AgentSpeakingChips />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'tab-1:leaf',
        activity: 'thinking',
        spokenName: 'oak'
      })
    })
    const chip = screen.getByTestId('agent-speaking-chip')
    expect(chip).toHaveTextContent('oak')
    expect(chip).not.toHaveTextContent('Claude')
    expect(chip).toHaveAttribute('data-activity', 'thinking')
  })

  it('renders a pane-less update (watchdog finding) by its spoken name', () => {
    mockAgentStatus({})
    render(<AgentSpeakingChips />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'run:run-1',
        activity: 'speaking',
        spokenName: 'oak'
      })
    })
    const chip = screen.getByTestId('agent-speaking-chip')
    expect(chip).toHaveTextContent('oak')
    expect(chip).not.toHaveTextContent('Unknown agent')
  })

  it('falls back to the provider label, then Unknown agent, without a spoken name', () => {
    mockAgentStatus({ 'tab-2:leaf': { agentType: 'claude' } })
    render(<AgentSpeakingChips />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'tab-2:leaf',
        activity: 'thinking'
      })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'tab-9:gone',
        activity: 'speaking'
      })
    })
    const chips = screen.getAllByTestId('agent-speaking-chip')
    expect(chips[0]).toHaveTextContent('Claude')
    expect(chips[1]).toHaveTextContent('Unknown agent')
  })

  it('drops the chip when the agent goes idle', () => {
    mockAgentStatus({})
    render(<AgentSpeakingChips />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
      publishVoiceControlAgentActivity({
        sessionId: 's1',
        paneKey: 'tab-1:leaf',
        activity: 'speaking',
        spokenName: 'oak'
      })
    })
    expect(screen.getByTestId('agent-speaking-chip')).toBeInTheDocument()
    act(() => {
      publishVoiceControlAgentActivity({ sessionId: 's1', paneKey: 'tab-1:leaf', activity: 'idle' })
    })
    expect(screen.queryByTestId('agent-speaking-chip')).not.toBeInTheDocument()
  })
})
