// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import type * as React from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useNativeChatDraft } from './use-native-chat-draft'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import NativeChatView from './NativeChatView'
import { useNativeChatFind } from './use-native-chat-find'
import { useAppStore } from '@/store'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'

vi.mock('./NativeChatResolvedView', () => ({ NativeChatResolvedView: ResolvedFindProbe }))

function ResolvedFindProbe({ sessionId }: NativeChatResolvedViewProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef(null)
  const messageListRef = useRef(null)
  const find = useNativeChatFind(true, rootRef, composerRef, messageListRef)
  return (
    <div ref={rootRef}>
      <span>Session {sessionId ?? 'none'}</span>
      <button onClick={() => find.open?.()}>Find</button>
      {find.isOpen ? (
        <input
          aria-label="Find in chat"
          value={find.query}
          onChange={(event) => find.setQuery(event.target.value)}
        />
      ) : null}
    </div>
  )
}

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
    useAppStore.setState(useAppStore.getInitialState())
  })

  it('keeps Find open with its query when the bridge first receives session metadata', () => {
    useAppStore.setState(useAppStore.getInitialState())
    const paneKey = 'tab-1:leaf-1'
    render(
      <NativeChatView
        terminalTabId="tab-1"
        paneKey={paneKey}
        launchAgent="codex"
        isVisible
        isFocusedGroup
        ownsTabWideLaunchDraft
      />
    )
    expect(screen.getByText('Session none')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    const input = screen.getByRole('textbox', { name: 'Find in chat' })
    fireEvent.change(input, { target: { value: 'keep this search' } })
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [paneKey]: entry({
            paneKey,
            agentType: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session' }
          })
        }
      })
    })
    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Find in chat' })).toBe(input)
    expect(input).toHaveValue('keep this search')
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
})
