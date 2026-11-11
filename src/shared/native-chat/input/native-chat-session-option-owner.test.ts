import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache,
  type NativeChatSessionOptionOwner
} from './native-chat-session-option-cache'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import type { NativeChatSessionOptionBinding } from './native-chat-session-option-binding'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-dispatch'

function binding(id: string): NativeChatSessionOptionBinding {
  return {
    agent: 'claude',
    connectionId: null,
    worktreeId: 'worktree',
    ptyId: 'pty',
    terminalHandle: 'terminal',
    providerSession: { key: 'session_id', id }
  }
}
function surface(
  scopeKey: string,
  owner: NativeChatSessionOptionOwner,
  dispatchCommand: NativeChatSessionOptionDispatchCommand = () => undefined,
  persistSelection = vi.fn()
) {
  return createNativeChatPtySessionOptions({
    agent: 'claude',
    scopeKey,
    owner,
    mode: 'live',
    modelLabel: 'Model',
    dispatchCommand,
    persistSelection
  })!
}

function expectReleased(scopeKey: string) {
  const replacement = createNativeChatSessionOptionRecord('claude')
  replacement.model = { value: 'release-control', source: 'applied' }
  writeNativeChatSessionOptionCache(scopeKey, replacement)
  expect(readNativeChatSessionOptionCache(scopeKey)).toEqual(replacement)
}

describe('live session option ownership', () => {
  beforeEach(clearNativeChatSessionOptionCacheForTests)

  it('returns an accepted original action without reviving it through any late writer', async () => {
    let current: NativeChatSessionOptionBinding | null = binding('A')
    const ownerA = { binding: current, readCurrentBinding: () => current }
    let accept!: () => void
    const dispatched = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const persistA = vi.fn()
    const a = surface('pty', ownerA, dispatched, persistA)
    const releaseA = a.subscribe(() => {})
    a.reportSessionOptions({ model: 'sonnet' })
    const result = a.setOption('model', 'opus')
    await Promise.resolve()
    expect(dispatched).toHaveBeenCalledOnce()
    current = binding('B')
    const b = surface('pty', { binding: current, readCurrentBinding: () => current })
    const changedB = vi.fn()
    const releaseB = b.subscribe(changedB)
    b.reportSessionOptions({ model: 'haiku' })
    changedB.mockClear()
    a.reportSessionOptions({ model: 'sonnet' })
    a.replaceModels([{ id: 'opus', label: 'Opus', options: [] }])
    a.recordOutgoingCommand('/model sonnet')
    accept()
    await expect(result).resolves.toHaveProperty('snapshot')
    expect(persistA).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'opus',
        optionId: 'model',
        value: 'opus',
        adoptModelAsLaunchDefault: true
      })
    )
    expect(b.getSnapshot()[0].kind).toMatchObject({ currentValue: 'haiku' })
    expect(changedB).not.toHaveBeenCalled()
    releaseA()
    releaseB()
    expect(readNativeChatSessionOptionCache('pty')?.model?.value).toBe('haiku')
    expectReleased('pty')
  })

  it('enriches an unknown owner, keeps pending ownership beyond inactive cache churn, then retires it', async () => {
    let current: NativeChatSessionOptionBinding | null = {
      ...binding('A'),
      providerSession: undefined
    }
    const original: NativeChatSessionOptionOwner = {
      binding: current,
      readCurrentBinding: () => current
    }
    let accept!: () => void
    const a = surface(
      'pty',
      original,
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const release = a.subscribe(() => {})
    a.reportSessionOptions({ model: 'sonnet' })
    current = binding('A')
    a.reportSessionOptions({ model: 'sonnet' })
    const result = a.setOption('model', 'opus')
    await Promise.resolve()
    release()
    for (let i = 0; i < 160; i++) {
      const identity = { ...binding(String(i)), ptyId: String(i) }
      const other = surface(String(i), { binding: identity, readCurrentBinding: () => identity })
      const close = other.subscribe(() => {})
      other.reportSessionOptions({ model: 'haiku' })
      close()
    }
    accept()
    await result
    expect(readNativeChatSessionOptionCache('pty')?.model?.value).toBe('opus')
    const remount = surface('pty', { binding: binding('A'), readCurrentBinding: () => current })
    const close = remount.subscribe(() => {})
    expect(remount.getSnapshot()[0].kind).toMatchObject({ currentValue: 'opus' })
    current = binding('B')
    a.reportSessionOptions({ model: 'sonnet' })
    remount.reportSessionOptions({ model: 'sonnet' })
    close()
    expect(readNativeChatSessionOptionCache('pty')?.model?.value).toBe('opus')
    expectReleased('pty')
  })

  it('does not start queued effects or resurrect a removed owner; subscribe can remount', async () => {
    let current: NativeChatSessionOptionBinding | null = binding('A')
    let accept!: () => void
    const dispatched = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const a = surface('pty', { binding: current, readCurrentBinding: () => current }, dispatched)
    const release = a.subscribe(() => {})
    a.reportSessionOptions({ model: 'sonnet' })
    const accepted = a.setOption('model', 'opus')
    const queued = a.setOption('model', 'haiku')
    const rejected = expect(queued).rejects.toThrow()
    await Promise.resolve()
    current = null
    release()
    accept()
    await accepted
    await rejected
    expect(dispatched).toHaveBeenCalledOnce()
    expect(readNativeChatSessionOptionCache('pty')?.model?.value).toBe('opus')
    await expect(a.setOption('model', 'haiku')).rejects.toThrow()
    expect(dispatched).toHaveBeenCalledOnce()
    current = binding('A')
    const close = a.subscribe(() => {})
    a.reportSessionOptions({ model: 'haiku' })
    expect(a.getSnapshot()[0].kind).toMatchObject({ currentValue: 'haiku' })
    close()
    expectReleased('pty')
  })

  it.each([false, true])(
    'settles to the same session when it reopens before acceptance: %s',
    async (reopenBeforeAcceptance) => {
      const identity = binding('A')
      let oldRouteLive = true
      let accept!: () => void
      const persist = vi.fn()
      const target = surface(
        'pty',
        {
          binding: identity,
          readCurrentBinding: () => (oldRouteLive ? identity : null)
        },
        () =>
          new Promise<void>((resolve) => {
            accept = resolve
          }),
        persist
      )
      const oldNotify = vi.fn()
      const close = target.subscribe(oldNotify)
      target.reportSessionOptions({ model: 'sonnet' })
      const picked = target.setOption('model', 'opus')
      await Promise.resolve()
      close()
      oldRouteLive = false
      oldNotify.mockClear()
      let reopened: ReturnType<typeof surface> | undefined
      let closeReopened: (() => void) | undefined
      const reopen = () => {
        reopened = surface('pty', { binding: identity, readCurrentBinding: () => identity })
        closeReopened = reopened.subscribe(() => {})
      }
      if (reopenBeforeAcceptance) {
        reopen()
      }
      accept()
      await picked
      if (!reopenBeforeAcceptance) {
        reopen()
      }
      expect(reopened!.getSnapshot()[0].kind).toMatchObject({ currentValue: 'opus' })
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'opus' }))
      expect(oldNotify).not.toHaveBeenCalled()
      closeReopened!()
      expectReleased('pty')
    }
  )

  it('keeps a replaced route silent before its successor subscribes', async () => {
    let current = binding('A')
    let accept!: () => void
    const target = surface(
      'pty',
      { binding: current, readCurrentBinding: () => current },
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const notify = vi.fn()
    const close = target.subscribe(notify)
    target.reportSessionOptions({ model: 'sonnet' })
    const picked = target.setOption('model', 'opus')
    await Promise.resolve()
    current = binding('B')
    notify.mockClear()
    accept()
    await picked
    expect(notify).not.toHaveBeenCalled()
    close()
    const successor = surface('pty', { binding: current, readCurrentBinding: () => current })
    const closeSuccessor = successor.subscribe(() => {})
    expect(successor.getSnapshot()[0].kind).not.toMatchObject({ currentValue: 'opus' })
    closeSuccessor()
    expectReleased('pty')
  })

  it('releases a StrictMode subscription replay and an unmounted pending operation', async () => {
    const identity = binding('A')
    let accept!: () => void
    const target = surface(
      'pty',
      { binding: identity, readCurrentBinding: () => identity },
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    target.subscribe(() => {})()
    expectReleased('pty')
    const close = target.subscribe(() => {})
    const result = target.setOption('model', 'opus')
    await Promise.resolve()
    close()
    accept()
    await result
    expectReleased('pty')
  })

  it('keeps WSL relay provenance on its local owner while isolating another remote host', async () => {
    let current: NativeChatSessionOptionBinding = {
      ...binding('A'),
      worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\qa\\project',
      connectionId: null
    }
    let accept!: () => void
    const dispatched = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve
        })
    )
    const target = surface(
      'pty',
      { binding: current, readCurrentBinding: () => current },
      dispatched
    )
    const close = target.subscribe(() => {})
    current = { ...current, connectionId: 'wsl:Ubuntu' }
    target.reportSessionOptions({ model: 'sonnet' })
    expect(target.getSnapshot()[0].kind).toMatchObject({ currentValue: 'sonnet' })
    const result = target.setOption('model', 'opus')
    await Promise.resolve()
    expect(dispatched).toHaveBeenCalledOnce()
    current = { ...current, connectionId: 'ssh:another-host' }
    const successor = surface('pty', { binding: current, readCurrentBinding: () => current })
    const closeSuccessor = successor.subscribe(() => {})
    successor.reportSessionOptions({ model: 'haiku' })
    accept()
    await result
    expect(successor.getSnapshot()[0].kind).toMatchObject({ currentValue: 'haiku' })
    close()
    closeSuccessor()
    expectReleased('pty')
  })

  it.each([100, 1000])('publishes only to the changed live scope among %i owners', (count) => {
    const owners = Array.from({ length: count }, (_, i) => {
      const identity = { ...binding(String(i)), ptyId: String(i) }
      const readCurrentBinding = vi.fn(() => identity)
      const target = surface(String(i), { binding: identity, readCurrentBinding })
      const notify = vi.fn()
      const release = target.subscribe(notify)
      notify.mockClear()
      readCurrentBinding.mockClear()
      return { target, readCurrentBinding, notify, release }
    })
    owners[0].target.reportSessionOptions({ model: 'haiku' })
    owners[0].target.reportSessionOptions({ model: 'haiku' })
    expect(owners[0].notify).toHaveBeenCalledOnce()
    for (const owner of owners.slice(1)) {
      expect(owner.readCurrentBinding).not.toHaveBeenCalled()
      expect(owner.notify).not.toHaveBeenCalled()
    }
    for (const owner of owners) {
      owner.release()
    }
    expectReleased('0')
    expectReleased(String(count - 1))
  })
})
