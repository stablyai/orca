// @vitest-environment happy-dom
import {
  script,
  rpc,
  SESSION,
  SCOPE,
  message,
  harness,
  begin,
  holdCalls,
  type Outcome
} from './structured-queued-edit.test-fixture'
import { act } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { QueuedEditHostFixtureModule } from '../../../../../../shared/queued-edit-host.test-fixture'

import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '../../drafts/native-chat-draft-views'

let queuedEditHost: QueuedEditHostFixtureModule['queuedEditHost']
beforeAll(async () => {
  const fixtures = await vi.importActual<QueuedEditHostFixtureModule>(
    '../../../../../../main/native-chat/agent-session-journal/queued-messages/queued-edit-host.test-fixture'
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
        await import('../../drafts/native-chat-composer-draft-insertion')
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
