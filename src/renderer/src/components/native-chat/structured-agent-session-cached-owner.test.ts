// @vitest-environment happy-dom
//
// A re-paired owner must serve the last transcript read-only. The id now names a different machine,
// so re-reading or mutating would address a stranger's journal.

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callStructuredAgentSession: vi.fn(async () => ({ ok: true, value: {} })),
  subscribeStructuredAgentSession: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession,
  subscribeStructuredAgentSession: mocks.subscribeStructuredAgentSession,
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() }))
}))

import { useStructuredAgentSession } from './use-structured-agent-session'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from './structured-agent-session-read-owner'

const ENVIRONMENT = { kind: 'environment', environmentId: 'env-a' } as const

beforeEach(() => {
  mocks.callStructuredAgentSession.mockClear()
})

afterEach(() => {
  resetStructuredAgentSessionReadOwnersForTests()
})

describe('the read owner is keyed on the pairing revision', () => {
  it('hands a re-paired host a separate owner instead of the open pane s transcript', () => {
    const before = getStructuredAgentSessionReadOwner('session-1', ENVIRONMENT, 3)
    expect(getStructuredAgentSessionReadOwner('session-1', ENVIRONMENT, 3)).toBe(before)
    expect(getStructuredAgentSessionReadOwner('session-1', ENVIRONMENT, 4)).not.toBe(before)
  })

  it('keeps one owner per session on a host with no pairing', () => {
    const local = getStructuredAgentSessionReadOwner('session-1', { kind: 'local' })
    expect(getStructuredAgentSessionReadOwner('session-1', { kind: 'local' })).toBe(local)
  })
})

describe('a stale owner turns the pane read-only', () => {
  it('reports cached, refuses sends and resolves mutations to nothing', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        target: ENVIRONMENT,
        ownerPairingRevision: 3,
        ownerPairingStale: true,
        agent: 'codex',
        isVisible: true
      })
    )
    expect(result.current.cached).toBe(true)
    expect(result.current.send('hello', [])).toBe(false)
    await expect(result.current.cancel('turn-1')).resolves.toBeNull()
    // Nothing addressed the host: no hold, no history read, no options probe.
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('reads and holds normally when the stamped pairing still matches', () => {
    const { result } = renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-2',
        target: ENVIRONMENT,
        ownerPairingRevision: 3,
        agent: 'codex',
        isVisible: true
      })
    )
    expect(result.current.cached).toBe(false)
    expect(mocks.callStructuredAgentSession).toHaveBeenCalled()
  })
})
