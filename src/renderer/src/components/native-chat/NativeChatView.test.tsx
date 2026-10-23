// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useContext, useRef } from 'react'
import type * as React from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useNativeChatDraft } from './use-native-chat-draft'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { NativeChatMarkdownImage } from './NativeChatMarkdownImage'
import {
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
import NativeChatView from './NativeChatView'
import { useNativeChatFind } from './use-native-chat-find'
import { useAppStore } from '@/store'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'

vi.mock('./NativeChatResolvedView', () => ({ NativeChatResolvedView: ResolvedFindProbe }))

function ResolvedFindProbe({ paneKey, sessionId }: NativeChatResolvedViewProps): React.JSX.Element {
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef(null)
  const messageListRef = useRef(null)
  const find = useNativeChatFind(true, rootRef, composerRef, messageListRef)
  return (
    <div ref={rootRef}>
      <DraftProbe paneKey={paneKey} sessionId={sessionId} />
      <output aria-label="File session">
        {owner?.runtimeContext?.nativeChatContext?.sessionId ?? 'no-session'}:
        {owner?.fileLinkContext?.chatSessionId ?? 'no-session'}
      </output>
      <NativeChatMarkdownImage src="https://example.com/chart.png" alt="Chart" />
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

  it('keeps the startup pane usable without inventing a chat file session identity', () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      repos: [repoFixture()],
      worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo', { hostId: 'local' })] },
      tabsByWorktree: { 'wt-1': [terminalTabFixture('tab-1', 'wt-1')] }
    })
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
    expect(screen.getByRole('status', { name: 'File session' })).toHaveTextContent(
      'no-session:no-session'
    )
    const composer = screen.getByRole('textbox', { name: 'Message draft' })
    fireEvent.change(composer, { target: { value: 'startup draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: {
          [paneKey]: entry({
            paneKey,
            agentType: 'codex',
            providerSession: { key: 'session_id', id: 'known-session' }
          })
        }
      })
    })
    expect(screen.getByRole('status', { name: 'File session' })).toHaveTextContent(
      'known-session:known-session'
    )
    expect(screen.queryByRole('dialog', { name: 'Chart' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toBe(composer)
    expect(composer).toHaveValue('startup draft')
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
})
