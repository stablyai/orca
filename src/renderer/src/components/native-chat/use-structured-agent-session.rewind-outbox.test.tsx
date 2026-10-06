// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  readOutbox,
  writeOutbox
} from './structured-agent-session-outbox-storage'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
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

describe("the host's in-doubt rewind latch and the outbox", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.send'
        ? new Promise(() => {})
        : Promise.resolve({ models: [], current: {}, rewind: { supported: true } })
    )
  })
  afterEach(() => vi.useRealTimers())

  // The host recovers an in-doubt rewind on the next send, so holding sends here would deadlock it.
  it.each(['queued', 'unconfirmed'] as const)(
    'keeps delivering a restored %s message and new sends while the latch is set',
    async (entryState) => {
      const entry = enqueueStructuredAgentSessionLaunchPrompt(args.sessionId, 'Pending prompt')!
      writeOutbox(args.sessionId, [{ ...entry, state: entryState }])
      const view = renderHook(() =>
        useStructuredAgentSession({ ...args, rewind: { hostBlockedReason: 'outcome-unknown' } })
      )
      await act(async () => {
        if (entryState === 'unconfirmed') {
          view.result.current.retry(entry.clientMessageId)
        }
        await vi.advanceTimersByTimeAsync(60_000)
      })
      const sends = () =>
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
      expect(sends()).toHaveLength(1)
      expect(view.result.current.send('New prompt', [])).toBe(true)
      expect(view.result.current.error).toBeNull()
      expect(readOutbox(args.sessionId).map((queued) => queued.clientMessageId)).toContain(
        entry.clientMessageId
      )
      view.unmount()
    }
  )
})
