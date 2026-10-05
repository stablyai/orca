// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { HostLeafConversation } from '../../../../shared/terminal-tab-types'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useNativeChatDraft } from './use-native-chat-draft'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'

function entry(overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>) {
  return {
    state: 'working' as const,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

function renderResolution(
  props: Omit<React.ComponentProps<typeof NativeChatSessionGate>, 'children'>
): void {
  render(
    <NativeChatSessionGate {...props}>
      {(resolution) => (
        <div data-testid="native-chat-resolution">
          {resolution.agent}:{resolution.sessionId ?? 'no-session'}:{resolution.paneKey}
        </div>
      )}
    </NativeChatSessionGate>
  )
}

const notComposing = (): boolean => false

function DraftProbe({ paneKey, sessionId }: { paneKey: string; sessionId: string | null }) {
  const { draft, setDraft } = useNativeChatDraft(paneKey, notComposing)
  return (
    <label>
      Session {sessionId ?? 'none'}
      <input
        aria-label="Message draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  )
}

describe('NativeChatSessionGate', () => {
  afterEach(() => {
    cleanup()
    clearNativeChatDraftCacheForTests()
  })

  it('preserves the open composer, session, and draft through disconnect and reconnect', () => {
    const paneKey = 'tab-1:leaf-1'
    const connectedEntry = entry({
      paneKey,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session' }
    })
    const renderGate = (
      agentStatusEntry?: AgentStatusEntry,
      launchAgent: 'codex' | null = null
    ) => (
      <NativeChatSessionGate
        paneKey={paneKey}
        launchAgent={launchAgent}
        resolvedAgent={null}
        agentStatusEntry={agentStatusEntry}
        ptyId={agentStatusEntry ? 'pty-connected' : null}
      >
        {(resolution) => (
          <DraftProbe paneKey={resolution.paneKey} sessionId={resolution.sessionId} />
        )}
      </NativeChatSessionGate>
    )
    const view = render(renderGate(connectedEntry))
    const composer = screen.getByRole('textbox', { name: 'Message draft' })

    fireEvent.change(composer, { target: { value: 'keep this unsent message' } })
    view.rerender(renderGate(undefined, 'codex'))

    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )

    view.rerender(renderGate())

    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )

    view.rerender(renderGate(connectedEntry))
    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )
  })

  it('does not open native chat from an unsupported title fallback', () => {
    renderResolution({
      paneKey: 'tab-1:leaf-1',
      launchAgent: null,
      resolvedAgent: 'gemini',
      ptyId: 'pty-1'
    })

    expect(screen.getByText('No conversation here')).toBeInTheDocument()
    expect(screen.queryByTestId('native-chat-resolution')).not.toBeInTheDocument()
  })

  describe('a paired host conversation field', () => {
    const paneKey = 'tab-1:leaf-1'
    const genuine = entry({
      paneKey,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'S' }
    })
    const identity = (id: string, agentType = 'codex') => ({
      agentType,
      providerSession: { key: 'session_id' as const, id },
      capturedAt: 10,
      source: 'live'
    })
    const gate = (
      agentStatusEntry: AgentStatusEntry | undefined,
      conversation: HostLeafConversation | undefined,
      launchAgent: 'codex' | null = null
    ) => (
      <NativeChatSessionGate
        paneKey={paneKey}
        launchAgent={launchAgent}
        resolvedAgent={null}
        agentStatusEntry={agentStatusEntry}
        conversation={conversation}
        ptyId="pty-1"
      >
        {(resolution) => (
          <div data-testid="native-chat-resolution">
            {resolution.agent}:{resolution.sessionId ?? 'no-session'}
          </div>
        )}
      </NativeChatSessionGate>
    )
    const shown = () => screen.queryByTestId('native-chat-resolution')?.textContent ?? 'empty'

    it('keeps S through a shell-titled statusless frame, then reads S from the offered field', () => {
      const view = render(gate(genuine, undefined))
      expect(shown()).toBe('codex:S')
      view.rerender(gate(undefined, { identity: identity('S'), offeredWithoutStatus: false }))
      expect(shown()).toBe('codex:S')
      view.rerender(gate(undefined, { identity: identity('S'), offeredWithoutStatus: true }))
      expect(shown()).toBe('codex:S')
    })

    it('gives a cold shell-titled frame no address', () => {
      render(gate(undefined, { identity: identity('S'), offeredWithoutStatus: false }))
      expect(shown()).toBe('empty')
    })

    it('keeps S on an absent-field reconnect, as an old host does today', () => {
      const view = render(gate(genuine, undefined))
      view.rerender(gate(undefined, undefined, 'codex'))
      expect(shown()).toBe('codex:S')
    })

    it('treats another agent field as absent and keeps the same-agent memory', () => {
      const view = render(gate(genuine, undefined))
      view.rerender(
        gate(entry({ paneKey, agentType: 'codex' }), {
          identity: identity('C', 'claude'),
          offeredWithoutStatus: false
        })
      )
      expect(shown()).toBe('codex:S')
    })

    it('keeps the same-agent memory when the host withholds the field (absent, never a clear)', () => {
      const addressless = entry({ paneKey, agentType: 'codex' })
      const view = render(
        gate(addressless, { identity: identity('T'), offeredWithoutStatus: false })
      )
      expect(shown()).toBe('codex:T')
      view.rerender(gate(addressless, undefined))
      expect(shown()).toBe('codex:T')
    })
  })
})
