// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionLinkSnapshot, LinkCreateParams } from '../../../../shared/session-link'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { useSessionLink } from './use-session-link'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn(async () => true) }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc.call,
  structuredAgentSessionHostSupports: rpc.supports
}))
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
      story: 'Slice 1b',
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
  story: 'Slice 1b',
  role: 'implementer'
}

describe('session link mutation recovery', () => {
  beforeEach(() => rpc.call.mockReset().mockResolvedValue(null))
  afterEach(cleanup)
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
    expect(result.current.snapshot?.link.story).toBe('Slice 1b')
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
    await waitFor(() => expect(result.current.supported).toBe(true))
    await act(async () => {
      await expect(result.current.show('old-link')).resolves.toBeUndefined()
    })
    expect(result.current.error).toBe('History unavailable')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600))
    })
    expect(
      rpc.call.mock.calls.filter(([, method]) => method === 'orchestration.linkShow')
    ).toHaveLength(1)
  })
})
