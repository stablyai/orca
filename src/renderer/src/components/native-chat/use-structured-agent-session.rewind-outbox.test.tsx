// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

const mocks = vi.hoisted(() => ({ call: vi.fn(), blocked: true }))
const state = {
  ...EMPTY_STRUCTURED_AGENT_SESSION,
  epoch: 'epoch-1',
  fence: 3,
  status: 'ready' as const
}

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./use-structured-agent-session-hold', () => ({
  useStructuredAgentSessionHold: () => undefined
}))
vi.mock('./use-structured-agent-session-status-summary', () => ({
  useStructuredAgentSessionStatusSummary: () =>
    mocks.blocked ? { rewindBlockedReason: 'outcome-unknown' } : null
}))
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({ state, loadingOlder: false, loadOlder: vi.fn() })
}))

import { useStructuredAgentSession } from './use-structured-agent-session'

const args = {
  sessionId: 'rewind-outbox',
  target: { kind: 'local' as const },
  agent: 'codex' as const,
  isVisible: true
}

describe('rewind recovery outbox suspension', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.blocked = true
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.send'
        ? new Promise(() => {})
        : Promise.resolve({ models: [], current: {}, rewind: { supported: true } })
    )
  })
  afterEach(() => vi.useRealTimers())

  it.each(['queued', 'unconfirmed'] as const)(
    'suspends a restored %s message, probes, and manual retry until the host clears recovery',
    async (entryState) => {
      const entry = enqueueStructuredAgentSessionLaunchPrompt(args.sessionId, 'Pending prompt')!
      writeOutbox(args.sessionId, [{ ...entry, state: entryState }])
      const view = renderHook(() => useStructuredAgentSession(args))
      await act(async () => {
        view.result.current.retry(entry.clientMessageId)
        await vi.advanceTimersByTimeAsync(60_000)
      })

      expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual(
        []
      )
      expect(readOutbox(args.sessionId)[0]?.state).toBe(entryState)
      expect(view.result.current.send('New prompt', [])).toBe(false)
      expect(view.result.current.error).toContain('The rewind may have completed')

      mocks.blocked = false
      await act(async () => view.rerender())
      if (entryState === 'unconfirmed') {
        await act(async () => view.result.current.retry(entry.clientMessageId))
      }
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
      ).toHaveLength(1)
      view.unmount()
    }
  )
})
