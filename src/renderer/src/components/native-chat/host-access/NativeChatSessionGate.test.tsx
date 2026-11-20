// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { expect, it } from 'vitest'
import { NativeChatSessionGate, type NativeChatSessionGateProps } from './NativeChatSessionGate'

it('clears the saved transcript on a confirmed id-less session in the same pane', () => {
  const pane = { paneKey: 'tab:leaf', ptyId: 'pty', launchAgent: 'claude' } as const
  type Props = Omit<NativeChatSessionGateProps, 'children'>
  const view = (props: Props) => (
    <NativeChatSessionGate {...props}>
      {({ sessionId, transcriptPath }) => (
        <span>
          {sessionId ?? 'pending'}|{transcriptPath ?? 'pending'}
        </span>
      )}
    </NativeChatSessionGate>
  )
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
