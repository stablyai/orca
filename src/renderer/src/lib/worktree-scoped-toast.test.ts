import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => {
  const listeners = new Set<(state: { activeWorktreeId: string | null }) => void>()
  const state: { activeWorktreeId: string | null; unrelated: number } = {
    activeWorktreeId: null,
    unrelated: 0
  }
  const store = { state, listeners }
  return { store }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.store.state,
    subscribe: (listener: (state: { activeWorktreeId: string | null }) => void) => {
      mocks.store.listeners.add(listener)
      return () => mocks.store.listeners.delete(listener)
    }
  }
}))

vi.mock('sonner', () => ({ toast: { dismiss: vi.fn() } }))

import { openWorktreeScopedToast } from './worktree-scoped-toast'

function setStoreState(patch: Partial<typeof mocks.store.state>): void {
  mocks.store.state = { ...mocks.store.state, ...patch }
  for (const listener of mocks.store.listeners) {
    listener(mocks.store.state)
  }
}

function openScopedToast(worktreeId = 'wt-a') {
  let nextId = 0
  const show = vi.fn((id: string | number | undefined) => id ?? `toast-${++nextId}`)
  const onHidden = vi.fn()
  const scoped = openWorktreeScopedToast({ worktreeId, show, onHidden })
  return { scoped, show, onHidden }
}

describe('openWorktreeScopedToast', () => {
  beforeEach(() => {
    mocks.store.state = { activeWorktreeId: 'wt-a', unrelated: 0 }
    mocks.store.listeners.clear()
    vi.mocked(toast.dismiss).mockClear()
  })

  it('shows right away when its workspace is active', () => {
    const { scoped, show } = openScopedToast()

    expect(show).toHaveBeenCalledWith(undefined)
    expect(scoped.isShown()).toBe(true)
  })

  it('stays hidden when the upload targets another workspace', () => {
    const { scoped, show } = openScopedToast('wt-b')

    expect(show).not.toHaveBeenCalled()
    expect(scoped.isShown()).toBe(false)
  })

  it('hides on switching away and comes back under a fresh id', () => {
    const { scoped, show, onHidden } = openScopedToast()

    setStoreState({ activeWorktreeId: 'wt-b' })
    expect(toast.dismiss).toHaveBeenCalledWith('toast-1')
    expect(onHidden).toHaveBeenCalledTimes(1)
    expect(scoped.isShown()).toBe(false)

    setStoreState({ activeWorktreeId: 'wt-a' })
    expect(show).toHaveBeenLastCalledWith(undefined)
    expect(show).toHaveBeenCalledTimes(2)
    expect(scoped.isShown()).toBe(true)
  })

  it('ignores store changes that keep the same workspace active', () => {
    const { show, onHidden } = openScopedToast()

    setStoreState({ unrelated: 1 })

    expect(show).toHaveBeenCalledTimes(1)
    expect(onHidden).not.toHaveBeenCalled()
  })

  it('refreshes in place only while shown', () => {
    const { scoped, show } = openScopedToast()

    scoped.refresh()
    expect(show).toHaveBeenLastCalledWith('toast-1')

    setStoreState({ activeWorktreeId: 'wt-b' })
    scoped.refresh()
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('stops following workspace switches once closed', () => {
    const { scoped, show } = openScopedToast()

    scoped.close()
    expect(toast.dismiss).toHaveBeenCalledWith('toast-1')

    setStoreState({ activeWorktreeId: 'wt-b' })
    setStoreState({ activeWorktreeId: 'wt-a' })
    scoped.refresh()

    expect(show).toHaveBeenCalledTimes(1)
    expect(scoped.isShown()).toBe(false)
    expect(mocks.store.listeners.size).toBe(0)
  })
})
