// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import { registerTerminalBacklogRecovery } from '@/lib/pane-manager/pane-terminal-output-queue-registry'
import {
  useWorkspaceTerminalReveal,
  WORKSPACE_TERMINAL_REVEAL_BUDGET_MS
} from './use-workspace-terminal-reveal'

const disposals: (() => void)[] = []

function restore() {
  let resolve = (): void => {}
  let reject = (): void => {}
  let pending: Promise<void> | null = new Promise<void>((yes, no) => {
    resolve = yes
    reject = () => no(new Error('host unavailable'))
  })
  void pending.then(
    () => {
      pending = null
    },
    () => {
      pending = null
    }
  )
  return { resolve, reject, completion: () => pending }
}

function fixture(initial = 'a', ids = ['a', 'b', 'c']) {
  const container = document.createElement('div')
  document.body.append(container)
  for (const id of ids) {
    const surface = document.createElement('div')
    surface.dataset.worktreeRevealId = id
    container.append(surface)
  }
  disposals.push(() => container.remove())
  const containerRef = { current: container }
  const result = renderHook(
    ({ selected, visible }) => useWorkspaceTerminalReveal(containerRef, selected, visible),
    { initialProps: { selected: initial, visible: true } }
  )
  const addPane = (id: string, completion: () => Promise<void> | null, hidden = false) => {
    const surface = Array.from(container.children).find(
      (child) => child instanceof HTMLElement && child.dataset.worktreeRevealId === id
    )
    if (!surface) {
      throw new Error(`Missing surface ${id}`)
    }
    const element = document.createElement('div')
    surface.append(element)
    const rects = hidden ? [] : [new DOMRect(0, 0, 100, 100)]
    vi.spyOn(element, 'getClientRects').mockReturnValue(
      Object.assign(rects, { item: (index: number) => rects[index] ?? null })
    )
    const terminal = { element, write: vi.fn() }
    const manager = {
      resetWebglTextureAtlases: vi.fn(),
      getPanes: () => [{ id: 1, terminal }]
    }
    registerLivePaneManager(manager)
    const request = vi.fn(() => true)
    const unregister = registerTerminalBacklogRecovery(terminal, request, completion)
    disposals.push(() => {
      unregister()
      unregisterLivePaneManager(manager)
    })
    return request
  }
  return { ...result, addPane }
}

async function frame(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20)
  })
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('workspace terminal reveal', () => {
  it('does not delay a workspace without pending catch-up', () => {
    const view = fixture()
    view.addPane('b', () => null)
    view.rerender({ selected: 'b', visible: true })
    expect(view.result.current.presentedWorktreeId).toBe('b')
  })

  it('retains the outgoing workspace until restore and the following paint boundary', async () => {
    const pending = restore()
    const view = fixture()
    view.addPane('b', pending.completion)
    view.rerender({ selected: 'b', visible: true })
    expect(view.result.current.presentedWorktreeId).toBe('a')
    await act(async () => {
      pending.resolve()
      await Promise.resolve()
    })
    expect(view.result.current.presentedWorktreeId).toBe('a')
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('b')
  })

  it('does not re-request a restore when checking whether catch-up finished', async () => {
    const pending = restore()
    const view = fixture()
    const request = view.addPane('b', pending.completion)
    view.rerender({ selected: 'b', visible: true })
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve()
    await frame()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('keeps late completion from presenting a superseded selection', async () => {
    const b = restore()
    const c = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.addPane('c', c.completion)
    view.rerender({ selected: 'b', visible: true })
    view.rerender({ selected: 'c', visible: true })
    b.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('a')
    c.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('c')
  })

  it('cancels the hold when switching back to the outgoing workspace', async () => {
    const b = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.rerender({ selected: 'b', visible: true })
    view.rerender({ selected: 'a', visible: true })
    b.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('a')
  })

  it('bounds a lost snapshot response without cancelling host work', async () => {
    const b = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.rerender({ selected: 'b', visible: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKSPACE_TERMINAL_REVEAL_BUDGET_MS - 1)
    })
    expect(view.result.current.presentedWorktreeId).toBe('a')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(view.result.current.presentedWorktreeId).toBe('b')
    expect(b.completion()).not.toBeNull()
  })

  it('releases on a failed snapshot instead of stranding navigation', async () => {
    const b = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.rerender({ selected: 'b', visible: true })
    b.reject()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('b')
  })

  it('releases immediately before a user interacts with the selected terminal', async () => {
    const b = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.rerender({ selected: 'b', visible: true })
    act(() => view.result.current.finishReveal())
    expect(view.result.current.presentedWorktreeId).toBe('b')
    b.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('b')
  })

  it('waits for every visible split leaf but not a hidden tab', async () => {
    const b1 = restore()
    const b2 = restore()
    const hidden = restore()
    const view = fixture()
    view.addPane('b', b1.completion)
    view.addPane('b', b2.completion)
    view.addPane('b', hidden.completion, true)
    view.rerender({ selected: 'b', visible: true })
    b1.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('a')
    b2.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('b')
  })

  it('keeps waiting when catch-up starts a second restore round', async () => {
    const first = restore()
    const second = restore()
    let completion = first.completion
    const view = fixture()
    view.addPane('b', () => completion())
    view.rerender({ selected: 'b', visible: true })
    completion = second.completion
    first.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('a')
    second.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe('b')
  })

  it('supports folder workspace identifiers without treating them as CSS selectors', async () => {
    const folder = 'folder::/remote/a [folder]'
    const pending = restore()
    const view = fixture('a', ['a', folder])
    view.addPane(folder, pending.completion)
    view.rerender({ selected: folder, visible: true })
    expect(view.result.current.presentedWorktreeId).toBe('a')
    pending.resolve()
    await frame()
    expect(view.result.current.presentedWorktreeId).toBe(folder)
  })

  it('releases when leaving terminal view', () => {
    const b = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.rerender({ selected: 'b', visible: true })
    view.rerender({ selected: 'b', visible: false })
    expect(view.result.current.presentedWorktreeId).toBe('b')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up a pending timer on unmount', async () => {
    const b = restore()
    const view = fixture()
    view.addPane('b', b.completion)
    view.rerender({ selected: 'b', visible: true })
    view.unmount()
    b.resolve()
    await frame()
    expect(vi.getTimerCount()).toBe(0)
  })
})
