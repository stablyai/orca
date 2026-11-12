// @vitest-environment happy-dom
import type * as SessionHostSupportModule from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SessionLinkSnapshot,
  LinkCreateParams,
  SESSION_LINK_PAIRED_DESKTOP_CAPABILITY
} from '../../../../shared/session-link'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useSessionLink } from './use-session-link'

const rpc = vi.hoisted(() => ({
  call: vi.fn(),
  supports: vi.fn(async (_target: unknown, _capability: string) => true)
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc.call
}))
vi.mock(
  '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support',
  async (importOriginal) => ({
    ...(await importOriginal<typeof SessionHostSupportModule>()),
    structuredAgentSessionHostSupports: rpc.supports
  })
)
const participant = (id: string) => ({
  sessionId: id,
  conversationId: id,
  name: id,
  agent: 'codex',
  role: 'implementer',
  workspaceId: 'workspace',
  directory: '/work',
  branch: 'feature',
  context: '',
  task: 'Implement'
})
const snapshot = (id: string) =>
  SessionLinkSnapshot.parse({
    link: {
      id,
      story: 'Checkout slice 2',
      participants: [participant('codex-work'), participant('claude-review')],
      state: 'active',
      reason: '',
      version: 1,
      turns: 0,
      messages: 0,
      createdAt: 1,
      updatedAt: 1
    },
    events: []
  })
const fields = {
  sessionId: 'codex-work',
  partnerSessionId: 'claude-review',
  story: 'Checkout slice 2',
  role: 'implementer'
}

beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue(null)
  rpc.supports.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
describe('session link mutation recovery', () => {
  function hook() {
    return renderHook(() => useSessionLink('codex-work', { kind: 'local' }, false))
  }

  it('retains the exact operation after a lost reply and forbids an unrelated mutation until it is reconciled', async () => {
    const calls: unknown[] = []
    rpc.call.mockImplementation(async (_target, method, params: unknown) => {
      if (method !== 'orchestration.linkCreate') {
        return null
      }
      const create = LinkCreateParams.parse(params)
      calls.push(create)
      if (calls.length === 1) {
        throw new Error('Reply lost')
      }
      return snapshot(create.id)
    })
    const { result } = hook()
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      expect(await result.current.mutate('orchestration.linkCreate', fields)).toBe(false)
    })
    expect(result.current.uncertain).toBe(true)
    await act(async () => {
      expect(
        await result.current.mutate('orchestration.linkCreate', { ...fields, story: 'Different' })
      ).toBe(false)
    })
    expect(calls).toHaveLength(1)
    await act(async () => {
      expect(await result.current.retry()).toBe(true)
    })
    expect(calls[0]).toEqual(calls[1])
    expect(result.current.uncertain).toBe(false)
    expect(result.current.snapshot?.link.story).toBe('Checkout slice 2')
  })

  it('allows correction after a proved effect-free refusal', async () => {
    rpc.call.mockImplementation(async (_target, method) => {
      if (method === 'orchestration.linkCreate') {
        throw new RuntimeRpcCallError({
          id: 'refused',
          ok: false,
          error: {
            code: 'session_link_refused',
            message: 'Choose an available session.',
            data: { effectsApplied: false }
          }
        })
      }
      return null
    })
    const { result } = hook()
    await act(async () => {
      await result.current.mutate('orchestration.linkCreate', fields)
    })
    expect(result.current.uncertain).toBe(false)
    rpc.call.mockImplementation(async (_target, method, params) =>
      method === 'orchestration.linkCreate' ? snapshot(LinkCreateParams.parse(params).id) : null
    )
    await act(async () => {
      expect(await result.current.mutate('orchestration.linkCreate', fields)).toBe(true)
    })
  })

  it('discards a delayed mutation answer when navigation changes the session', async () => {
    const delayed = Promise.withResolvers<unknown>()
    rpc.call.mockImplementation(async (_target, method) =>
      method === 'orchestration.linkCreate' ? delayed.promise : null
    )
    const { result, rerender } = renderHook(
      ({ id }) => useSessionLink(id, { kind: 'local' }, false),
      { initialProps: { id: 'codex-work' } }
    )
    let outcome: Promise<boolean> | undefined
    act(() => {
      outcome = result.current.mutate('orchestration.linkCreate', fields)
    })
    rerender({ id: 'other-chat' })
    await act(async () => {
      delayed.resolve(snapshot('old-link'))
      await outcome
    })
    expect(result.current.snapshot).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it('reports a failed history read and stops polling the unavailable selected link', async () => {
    vi.useFakeTimers()
    rpc.call.mockImplementation(async (_target, method) => {
      if (method === 'orchestration.linkCandidates') {
        return { source: participant('codex-work'), candidates: [], history: [] }
      }
      if (method === 'orchestration.linkShow') {
        throw new Error('History unavailable')
      }
      return null
    })
    const { result } = renderHook(() => useSessionLink('codex-work', { kind: 'local' }, true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.supported).toBe(true)
    await act(async () => {
      await expect(result.current.show('old-link')).resolves.toBeUndefined()
    })
    expect(result.current.error).toBe('History unavailable')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(
      rpc.call.mock.calls.filter(([, method]) => method === 'orchestration.linkShow')
    ).toHaveLength(1)
  })
})

it('reads and resumes a link on its remote host without querying the local runtime', async () => {
  const target = { kind: 'environment', environmentId: 'macbook' } as const
  rpc.supports.mockResolvedValue(true)
  rpc.call.mockImplementation(async (_target, method) =>
    method === 'orchestration.linkCurrent' || method === 'orchestration.linkControl'
      ? snapshot('remote-link')
      : null
  )
  const { result } = renderHook(() => useSessionLink('codex-work', target, false))
  await waitFor(() => expect(result.current.snapshot?.link.id).toBe('remote-link'))
  expect(rpc.supports).toHaveBeenCalledWith(target, SESSION_LINK_PAIRED_DESKTOP_CAPABILITY)
  await act(async () => {
    expect(
      await result.current.mutate('orchestration.linkControl', {
        id: 'remote-link',
        action: 'resume',
        version: 1
      })
    ).toBe(true)
  })
  expect(
    rpc.call.mock.calls.every(([destination]) => destination.environmentId === 'macbook')
  ).toBe(true)
})

it('does not query links on an older remote host without the capability', async () => {
  rpc.supports.mockImplementation(
    async (_target, capability) => capability !== SESSION_LINK_PAIRED_DESKTOP_CAPABILITY
  )
  const { result } = renderHook(() =>
    useSessionLink(
      'codex-work',
      {
        kind: 'environment',
        environmentId: 'older-host'
      },
      false
    )
  )
  await act(async () => {})
  expect(result.current.supported).toBe(false)
  expect(rpc.call).not.toHaveBeenCalled()
  rpc.supports.mockResolvedValue(true)
})
