// @vitest-environment happy-dom
import {
  script,
  rpc,
  HELD,
  SESSION,
  SCOPE,
  message,
  harness,
  begin,
  requestedFingerprint,
  holdCalls,
  type Outcome
} from './structured-queued-edit.test-fixture'
import { act, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { QueuedEditHostFixtureModule } from '../../../../shared/queued-edit-host.test-fixture'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../../shared/agent-session-wire'
import { readNativeChatDraftCache, writeNativeChatDraftCache } from './native-chat-draft-cache'

let queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../../../../main/native-chat/agent-session-journal/queued-edit-host.test-fixture'
  )
  queuedEditHost = fixtures.queuedEditHost
})

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe('current desktop reacquisition and Save share the outcome owner', () => {
  it.each([
    'updated',
    'unchanged',
    'newer',
    'fresh-loss',
    'gone',
    'refused',
    'unknown',
    'late-unknown',
    'depart',
    'depart-equal'
  ] as const)('%s settles a real host decision before current lease loss', async (mode) => {
    const host = queuedEditHost(SESSION, message)
    const hook = harness()
    await begin(hook)
    const loss = deferred<AgentSessionQueuedMessageEditHoldResult>()
    const freshLoss = deferred<AgentSessionQueuedMessageEditHoldResult>()
    let expected = ''
    let editId = ''
    let acquires = 0
    rpc.mockImplementation(async (_target, _method, params) => {
      if (params.action === 'release') {
        host.leases.release({ callerKey: 'client', editId: params.editId }, params.messageId)
        return { status: 'released' }
      }
      if (params.action !== 'acquire') {
        return HELD
      }
      acquires++
      expected = params.expectedBodyFingerprint ?? ''
      editId = params.editId
      return acquires === 1
        ? loss.promise
        : mode === 'fresh-loss'
          ? freshLoss.promise
          : host.acquire(editId, expected)
    })
    // Desktop initial acquisition is read-only; reach its real unblocked re-acquisition.
    const first = deferred<Outcome>()
    script.answer = () => first.promise
    act(() => {
      hook.result.current.editor!.change('A')
      hook.result.current.editor!.save()
    })
    const fpA = requestedFingerprint()
    host.update({ messageId: 'card', expectedBodyFingerprint: host.row!.fingerprint, text: 'A' })
    const scope = hook.result.current.editor!.draftScopeKey
    const { insertNativeChatComposerDraftText } =
      await import('./native-chat-composer-draft-insertion')
    act(() => insertNativeChatComposerDraftText(scope, 'B'))
    await act(async () =>
      first.resolve({
        kind: 'done',
        value: { status: 'updated', messageId: 'card', fingerprint: fpA }
      })
    )
    expect(hook.result.current.editor).toMatchObject({ text: 'A B', acquiring: false })
    writeNativeChatDraftCache(SCOPE, 'occupied')
    const reply = deferred<Outcome>()
    script.answer = () => reply.promise
    if (mode === 'unchanged') {
      host.update({
        messageId: 'card',
        expectedBodyFingerprint: host.row!.fingerprint,
        text: 'A B'
      })
    }
    act(() => hook.result.current.editor!.save())
    const decision = host.update({
      messageId: 'card',
      expectedBodyFingerprint: expected,
      text: 'A B'
    })
    expect(decision.status).toBe(mode === 'unchanged' ? 'unchanged' : 'updated')
    if (mode === 'newer' || mode === 'fresh-loss' || mode === 'gone' || mode === 'depart') {
      act(() => insertNativeChatComposerDraftText(scope, 'C'))
    }
    if (mode === 'gone') {
      host.depart()
    }
    const negative = host.acquire(editId, expected)
    expect(negative.status).toBe(mode === 'gone' ? 'gone' : 'changed')
    if (mode === 'depart' || mode === 'depart-equal') {
      hook.unmount()
    }
    if (mode !== 'late-unknown') {
      await act(async () => loss.resolve(negative))
      if (mode !== 'depart' && mode !== 'depart-equal') {
        expect(hook.result.current.editor?.saving).toBe(true)
      }
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      expect(toast.error).not.toHaveBeenCalled()
    }
    const result: Outcome =
      mode === 'unknown' || mode === 'late-unknown'
        ? { kind: 'not-done', notice: 'unknown', failure: { kind: 'unconfirmed' } }
        : mode === 'refused'
          ? { kind: 'done', value: { status: 'not-editable', messageId: 'card' } }
          : { kind: 'done', value: decision }
    await act(async () => reply.resolve(result))
    if (mode === 'late-unknown') {
      expect(hook.result.current.editor).toMatchObject({ saving: false })
      await act(async () => loss.resolve(negative))
    }
    if (mode === 'newer' || mode === 'fresh-loss') {
      expect(hook.result.current.editor).toMatchObject({ text: 'A B C', saving: false })
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      expect(acquires).toBe(2)
      if (mode === 'newer') {
        expect(host.leases.heldIds()).toEqual(new Set(['card']))
      }
      host.depart()
      if (mode === 'fresh-loss') {
        await act(async () => freshLoss.resolve(host.acquire(editId, expected)))
        expect(hook.result.current.editor).toBeUndefined()
      }
      // A fresh negative is a fact about B, not the retired A mismatch.
      hook.rerender({ messages: [] })
      await waitFor(() => expect(hook.result.current.editor).toBeUndefined())
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied\n\nA B C')
    } else if (
      mode === 'gone' ||
      mode === 'unknown' ||
      mode === 'late-unknown' ||
      mode === 'refused' ||
      mode === 'depart'
    ) {
      if (mode !== 'depart') {
        expect(hook.result.current.editor).toBeUndefined()
      }
      expect(readNativeChatDraftCache(SCOPE)).toBe(
        `occupied\n\nA B${mode === 'gone' || mode === 'depart' ? ' C' : ''}`
      )
      expect(toast.error).toHaveBeenCalledOnce()
    } else {
      if (mode !== 'depart-equal') {
        expect(hook.result.current.editor).toBeUndefined()
      }
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      expect(toast.error).not.toHaveBeenCalled()
    }
    host.leases.dispose()
  })
})

it.each(['unknown-changed', 'unknown-gone', 'pending-proof', 'rebase-loss'] as const)(
  '%s joins the timed renewal/reacquisition producer to the Save owner without publication',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const host = queuedEditHost(SESSION, message)
    const actions: string[] = []
    rpc.mockImplementation(async (_target, _method, params) => {
      actions.push(params.action)
      const key = { callerKey: 'client', editId: params.editId }
      if (params.action === 'release') {
        host.leases.release(key, params.messageId)
        return { status: 'released' }
      }
      return params.action === 'acquire'
        ? host.acquire(params.editId, params.expectedBodyFingerprint ?? '')
        : host.leases.renew(key, params.messageId)
    })
    const hook = harness()
    await begin(hook)
    writeNativeChatDraftCache(SCOPE, 'occupied')
    const reply = deferred<Outcome>()
    script.answer = () => reply.promise
    act(() => hook.result.current.editor!.change('B'))
    act(() => hook.result.current.editor!.save())
    const decision = host.update({
      messageId: 'card',
      expectedBodyFingerprint: host.row!.fingerprint,
      text: 'B'
    })
    expect(decision.status).toBe('updated')
    if (mode === 'rebase-loss') {
      const { insertNativeChatComposerDraftText } =
        await import('./native-chat-composer-draft-insertion')
      act(() => insertNativeChatComposerDraftText(hook.result.current.editor!.draftScopeKey, 'C'))
    }
    if (mode !== 'pending-proof') {
      await act(async () =>
        reply.resolve(
          mode === 'rebase-loss'
            ? { kind: 'done', value: decision }
            : { kind: 'not-done', notice: 'unknown', failure: { kind: 'unconfirmed' } }
        )
      )
      expect(hook.result.current.editor).toMatchObject({
        text: mode === 'rebase-loss' ? 'B C' : 'B',
        saving: false
      })
    }
    if (mode === 'unknown-gone') {
      host.depart()
    }
    if (mode === 'rebase-loss') {
      expect(host.leases.heldIds()).toEqual(new Set(['card']))
      hook.rerender({ messages: [{ ...message, body: host.row!.body }] })
      expect(
        host.update({
          messageId: 'card',
          expectedBodyFingerprint: host.row!.fingerprint,
          text: 'rival'
        }).status
      ).toBe('updated')
    }
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    if (mode === 'pending-proof') {
      expect(hook.result.current.editor?.saving).toBe(true)
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      expect(toast.error).not.toHaveBeenCalled()
      await act(async () => reply.resolve({ kind: 'done', value: decision }))
    }
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe(
      mode === 'pending-proof' ? 'occupied' : `occupied\n\n${mode === 'rebase-loss' ? 'B C' : 'B'}`
    )
    expect(toast.error).toHaveBeenCalledTimes(mode === 'pending-proof' ? 0 : 1)
    expect(actions).toEqual(
      mode === 'rebase-loss'
        ? ['acquire', 'acquire', 'release', 'renew', 'acquire', 'release']
        : ['acquire', 'renew', 'acquire', 'release']
    )
    await act(() => vi.advanceTimersByTimeAsync(120_000))
    expect(holdCalls('acquire')).toHaveLength(mode === 'rebase-loss' ? 3 : 2)
    hook.unmount()
    host.leases.dispose()
    expect(vi.getTimerCount()).toBe(0)
  }
)

it.each(['gone', 'held'] as const)(
  'first acquire failure unlocks typing and its timed %s retry is observed',
  async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = queuedEditHost(SESSION, message)
    rpc
      .mockImplementation(async (_target, _method, params) => {
        if (params.action === 'release') {
          return { status: 'released' }
        }
        return host.acquire(
          params.editId,
          params.action === 'acquire' ? (params.expectedBodyFingerprint ?? '') : ''
        )
      })
      .mockRejectedValueOnce(new Error('offline'))
    const hook = harness()
    await begin(hook)
    expect(hook.result.current.editor?.acquiring).toBe(false)
    writeNativeChatDraftCache(SCOPE, 'occupied')
    act(() => hook.result.current.editor!.change('B'))
    if (status === 'gone') {
      host.depart()
    }
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(holdCalls('acquire')).toHaveLength(2)
    if (status === 'gone') {
      expect(hook.result.current.editor).toBeUndefined()
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied\n\nB')
      expect(toast.error).toHaveBeenCalledOnce()
    } else {
      expect(hook.result.current.editor).toMatchObject({ text: 'B', acquiring: false })
      expect(readNativeChatDraftCache(SCOPE)).toBe('occupied')
      act(() => hook.result.current.editor!.cancel())
    }
    hook.unmount()
    host.leases.dispose()
    warn.mockRestore()
  }
)

it.each(['changed', 'gone', 'not-editable'] as const)(
  'initial desktop %s has one clean disposition and readiness cannot revive it',
  async (status) => {
    rpc.mockResolvedValueOnce({ status })
    const hook = harness()
    await begin(hook)
    expect(hook.result.current.editor).toBeUndefined()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(toast.error).toHaveBeenCalledTimes(status === 'not-editable' ? 1 : 0)
    expect(holdCalls('release')).toHaveLength(1)
  }
)
