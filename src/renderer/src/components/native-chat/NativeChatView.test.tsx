// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import { AgentStatusObservationSequencer } from '../../../../shared/agent-status-observation'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
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

  it('keeps restored history through newer OSC snapshots until an explicit session boundary', () => {
    const paneKey = 'tab-1:leaf-1'
    const resumeIdentity = {
      paneKey,
      worktreeId: 'workspace-1',
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'restored-session' },
      state: 'working' as const,
      prompt: '',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live' as const
    }
    const gate = (agentStatusEntry?: AgentStatusEntry) => (
      <NativeChatSessionGate
        paneKey={paneKey}
        launchAgent="codex"
        ptyId="pty-1"
        resumeIdentity={resumeIdentity}
        agentStatusEntry={agentStatusEntry}
      >
        {(resolution) => <span>Session {resolution.sessionId ?? 'none'}</span>}
      </NativeChatSessionGate>
    )
    const view = render(gate())
    expect(screen.getByText('Session restored-session')).toBeInTheDocument()
    view.rerender(
      gate(entry({ paneKey, agentType: 'codex', updatedAt: 150, restoredUnconfirmed: true }))
    )
    expect(screen.getByText('Session restored-session')).toBeInTheDocument()
    view.rerender(
      gate(
        entry({
          paneKey,
          agentType: 'codex',
          updatedAt: 200,
          observation: new AgentStatusObservationSequencer('renderer-test').observe(paneKey, {
            origin: 'osc',
            kind: 'snapshot',
            observedAt: 200
          })
        })
      )
    )
    expect(screen.getByText('Session restored-session')).toBeInTheDocument()
    view.rerender(
      gate(
        entry({ paneKey, agentType: 'codex', updatedAt: 201, state: 'done', sessionBoundary: true })
      )
    )
    expect(screen.getByText('Session none')).toBeInTheDocument()
    view.rerender(
      gate(
        entry({
          paneKey,
          agentType: 'codex',
          updatedAt: 201,
          providerSession: { key: 'session_id', id: 'new-session' }
        })
      )
    )
    expect(screen.getByText('Session new-session')).toBeInTheDocument()
  })

  it.each(['session-boundary', 'launch-transition'] as const)(
    'preserves metadata gaps but clears %s',
    (boundary) => {
      const paneKey = 'tab-1:leaf-1'
      const gate = (agentStatusEntry: AgentStatusEntry) => (
        <NativeChatSessionGate
          paneKey={paneKey}
          launchAgent="codex"
          ptyId="pty-1"
          agentStatusEntry={agentStatusEntry}
        >
          {(resolution) => <span>Session {resolution.sessionId ?? 'none'}</span>}
        </NativeChatSessionGate>
      )
      const view = render(
        gate(
          entry({
            paneKey,
            agentType: 'codex',
            providerSession: { key: 'session_id', id: 'session-1' }
          })
        )
      )
      view.rerender(gate(entry({ paneKey, agentType: 'codex' })))
      expect(screen.getByText('Session session-1')).toBeInTheDocument()
      view.rerender(
        gate(
          entry({
            paneKey,
            agentType: 'codex',
            state: 'done',
            ...(boundary === 'session-boundary'
              ? { sessionBoundary: true }
              : {
                  observation: new AgentStatusObservationSequencer('renderer-test').observe(
                    paneKey,
                    {
                      origin: 'launch',
                      kind: 'transition',
                      observedAt: 200
                    }
                  )
                })
          })
        )
      )
      expect(screen.getByText('Session none')).toBeInTheDocument()
    }
  )

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
})
