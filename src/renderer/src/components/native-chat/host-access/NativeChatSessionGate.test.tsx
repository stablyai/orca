// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { NativeChatSessionGate, type NativeChatSessionGateProps } from './NativeChatSessionGate'

const view = (props: Omit<NativeChatSessionGateProps, 'children'>) => (
  <NativeChatSessionGate {...props}>
    {({ sessionId, transcriptPath }) => (
      <span data-session>
        {sessionId ?? 'pending'}|{transcriptPath ?? 'pending'}
      </span>
    )}
  </NativeChatSessionGate>
)

it('clears the saved transcript on a confirmed id-less session in the same pane', () => {
  const pane = { paneKey: 'tab:leaf', ptyId: 'pty', launchAgent: 'claude' } as const
  const saved = {
    paneKey: pane.paneKey,
    worktreeId: 'workspace',
    origin: 'live',
    agent: 'claude',
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    providerSession: { key: 'session_id', id: 'previous', transcriptPath: 'previous.jsonl' }
  } as const
  const entry = {
    paneKey: pane.paneKey,
    agentType: 'claude' as const,
    state: 'working' as const,
    stateStartedAt: 2,
    updatedAt: 2,
    prompt: '',
    stateHistory: []
  }
  const { container, rerender } = render(view({ ...pane, saved }))
  expect(container.textContent).toBe('previous|previous.jsonl')
  rerender(view({ ...pane }))
  expect(container.textContent).toBe('previous|previous.jsonl')
  rerender(view({ ...pane, agentStatusEntry: entry }))
  expect(container.textContent).toBe('pending|pending')
  rerender(
    view({
      ...pane,
      agentStatusEntry: {
        ...entry,
        providerSession: { key: 'session_id', id: 'next', transcriptPath: 'next.jsonl' }
      }
    })
  )
  expect(container.textContent).toBe('next|next.jsonl')
})

it('keeps a verified conversation across terminal replacement and rejects a different or unidentified session', () => {
  const pane = { paneKey: 'tab:leaf', ptyId: 'terminal-a', launchAgent: 'claude' } as const
  const entry = {
    paneKey: pane.paneKey,
    state: 'working' as const,
    agentType: 'claude' as const,
    updatedAt: 2,
    stateStartedAt: 1,
    prompt: '',
    stateHistory: [],
    orcaSessionId: 'conversation-a'
  }
  const providerSession = {
    key: 'session_id',
    id: 'provider-a',
    transcriptPath: 'a.jsonl'
  } as const
  const initial = { ...pane, agentStatusEntry: { ...entry, providerSession } }
  const reconnected = { ...pane, ptyId: 'terminal-b', agentStatusEntry: entry }
  const { container, rerender } = render(view(initial))
  rerender(view({ ...pane, ptyId: null }))
  rerender(view(reconnected))
  expect(container.textContent).toBe('provider-a|a.jsonl')
  rerender(
    view({
      ...reconnected,
      ptyId: 'terminal-c',
      agentStatusEntry: { ...entry, orcaSessionId: 'conversation-b' }
    })
  )
  expect(container.textContent).toBe('pending|pending')
  rerender(view(initial))
  rerender(view({ ...pane, ptyId: null }))
  rerender(view({ ...pane, ptyId: 'different-terminal' }))
  expect(container.textContent).toBe('pending|pending')
})

it('clears the transcript as soon as a shell takes over, even with stale Claude status', () => {
  const pane = { paneKey: 'tab:leaf', ptyId: 'terminal', launchAgent: 'claude' } as const
  const entry = {
    paneKey: pane.paneKey,
    state: 'done' as const,
    agentType: 'claude' as const,
    updatedAt: 2,
    stateStartedAt: 1,
    prompt: '',
    stateHistory: [],
    providerSession: {
      key: 'session_id' as const,
      id: 'previous',
      transcriptPath: 'previous.jsonl'
    }
  }
  const { container, rerender } = render(view({ ...pane, agentStatusEntry: entry }))
  expect(container.textContent).toBe('previous|previous.jsonl')
  rerender(view({ ...pane, shellForeground: true, agentStatusEntry: entry }))
  expect(container.querySelector('span[data-session]')).toBeNull()
  rerender(view(pane))
  expect(container.textContent).toBe('pending|pending')
})
