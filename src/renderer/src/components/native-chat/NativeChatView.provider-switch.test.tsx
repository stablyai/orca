// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { writeNativeChatProviderContinuation } from './native-chat-provider-continuation'

const { status } = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock('./use-native-chat-status-entry', () => ({ useNativeChatStatusEntry: status }))
vi.mock('./NativeChatStructuredSession', () => ({ NativeChatStructuredSession: () => null }))
vi.mock('./NativeChatResolvedView', () => ({
  NativeChatResolvedView: (props: { agent: string; sessionId: string | null }) => (
    <div>
      {props.agent}:{props.sessionId ?? 'no-session'}
    </div>
  )
}))
import NativeChatView from './NativeChatView'

const paneKey = 'switch-tab:leaf'
afterEach(() => {
  cleanup()
  writeNativeChatProviderContinuation(paneKey, null)
})
describe('native chat provider switch resolution', () => {
  it('uses the bound replacement provider when the terminal ID is reused', () => {
    writeNativeChatProviderContinuation(paneKey, {
      agent: 'grok',
      sourcePtyId: 'same',
      targetPtyId: 'same',
      messages: [],
      context: 'history'
    })
    status.mockReturnValue({ paneKey, entry: null })
    render(
      <NativeChatView
        terminalTabId="switch-tab"
        paneKey={paneKey}
        targetPtyId="same"
        launchAgent="claude"
        resolvedAgent="claude"
        ownsTabWideLaunchDraft={false}
        isVisible
      />
    )
    expect(screen.getByText('grok:no-session')).toBeInTheDocument()
  })
  it('renders the actual provider response when a replacement resumes a different provider', () => {
    writeNativeChatProviderContinuation(paneKey, {
      agent: 'grok',
      sourcePtyId: 'old',
      targetPtyId: 'new',
      messages: [],
      context: 'history'
    })
    const entry: AgentStatusEntry = {
      paneKey,
      agentType: 'claude',
      state: 'done',
      prompt: '',
      updatedAt: 2,
      stateStartedAt: 2,
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'actual-claude-session' }
    }
    status.mockReturnValue({ paneKey, entry })
    render(
      <NativeChatView
        terminalTabId="switch-tab"
        paneKey={paneKey}
        targetPtyId="new"
        launchAgent="claude"
        resolvedAgent="claude"
        ownsTabWideLaunchDraft={false}
        isVisible
      />
    )
    expect(screen.getByText('claude:actual-claude-session')).toBeInTheDocument()
  })
})
