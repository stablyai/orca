// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_DECLARATIVE_ERROR_MAX_CHARS,
  usePluginDeclarativeTree
} from './use-plugin-declarative-tree'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const button = (id: string) => ({
  type: 'Button',
  key: '#0',
  props: { onPress: { $callback: id } },
  children: ['Go']
})

function setup() {
  const send = vi.fn()
  let clock = 0
  const hook = renderHook(() => usePluginDeclarativeTree(send, { now: () => clock }))
  const flushFrame = async () => {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    })
  }
  return { send, hook, flushFrame, advance: (ms: number) => (clock += ms) }
}

afterEach(() => vi.restoreAllMocks())

describe('usePluginDeclarativeTree', () => {
  it('acknowledges accepted and refused renders so the guest keeps the tree on screen live', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { send, hook, flushFrame } = setup()
    hook.result.current.channel.onRender({ document: 'd1', revision: 1, tree: button('c1') })
    await flushFrame()
    expect(send).toHaveBeenLastCalledWith('ui.ack', { document: 'd1', revision: 1, accepted: true })
    hook.result.current.channel.onRender({ document: 'd1', revision: 2, tree: { type: 'div' } })
    await flushFrame()
    expect(send).toHaveBeenLastCalledWith('ui.ack', {
      document: 'd1',
      revision: 2,
      accepted: false
    })
    expect(hook.result.current.rendered?.revision).toBe(1)
    expect(hook.result.current.issue?.source).toBe('orca')
  })

  it('asks the guest to retry a rate-limited render, but not an oversized one', () => {
    const { send, hook } = setup()
    const message = (revision: number) => ({
      kind: 'evt',
      payload: { document: 'd1', revision, tree: null }
    })
    act(() => hook.result.current.channel.onRefused?.(message(4), 30))
    expect(send).toHaveBeenLastCalledWith('ui.ack', {
      document: 'd1',
      revision: 4,
      accepted: false,
      retryAfterMs: 100
    })
    act(() => hook.result.current.channel.onRefused?.(message(5), null))
    expect(send).toHaveBeenLastCalledWith('ui.ack', {
      document: 'd1',
      revision: 5,
      accepted: false
    })
  })

  it('attributes and clamps plugin errors, and keeps a repeated one as the same issue', async () => {
    const { hook, flushFrame } = setup()
    hook.result.current.channel.onRender({ document: 'd1', revision: 1, tree: button('c1') })
    await flushFrame()
    act(() => hook.result.current.channel.onError({ revision: 1, message: 'x'.repeat(1000) }))
    const first = hook.result.current.issue
    expect(first?.source).toBe('plugin')
    expect(first?.message.length).toBe(PLUGIN_DECLARATIVE_ERROR_MAX_CHARS)
    act(() => hook.result.current.channel.onError({ revision: 1, message: 'x'.repeat(1000) }))
    expect(hook.result.current.issue).toBe(first)
  })

  it('keeps the last good tree when a new guest fails to load, and counts the reload that fixes it', async () => {
    const { hook, flushFrame } = setup()
    act(() => hook.result.current.channel.onError({ revision: 0, message: 'a.tsx:1:1: first' }))
    // Nothing has rendered yet: still a load failure.
    expect(hook.result.current.issue).toEqual({ source: 'load', message: 'a.tsx:1:1: first' })
    hook.result.current.channel.onRender({ document: 'd1', revision: 1, tree: button('c1') })
    await flushFrame()
    expect(hook.result.current.issue).toBeNull()
    expect(hook.result.current.reloads).toBe(0)

    // A dev save: a new guest starts, and its module throws before rendering.
    act(() => hook.result.current.resetDocument())
    act(() =>
      hook.result.current.channel.onError({ revision: 0, message: 'src/panel.tsx:3:5: Unexpected' })
    )
    expect(hook.result.current.issue?.source).toBe('load')
    expect(hook.result.current.rendered).toMatchObject({ document: 'd1', revision: 1 })
    act(() => hook.result.current.dismissIssue())
    expect(hook.result.current.issue).toBeNull()
    expect(hook.result.current.rendered?.document).toBe('d1')

    // The next save loads: its first tree replaces the old one and clears the banner.
    act(() => hook.result.current.resetDocument())
    act(() => hook.result.current.channel.onError({ revision: 0, message: 'still broken' }))
    hook.result.current.channel.onRender({ document: 'd2', revision: 1, tree: button('c2') })
    await flushFrame()
    expect(hook.result.current.rendered?.document).toBe('d2')
    expect(hook.result.current.issue).toBeNull()
    expect(hook.result.current.reloads).toBe(1)
  })

  it('grants a gesture only for a press on a control that is settled in the tree and on screen', async () => {
    const { hook, flushFrame, advance } = setup()
    hook.result.current.channel.onRender({ document: 'd1', revision: 1, tree: button('c1') })
    await flushFrame()
    const element = document.createElement('button')
    document.body.append(element)
    let top = 0
    element.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: top, width: 40, height: 20 })
    hook.result.current.gestures.refFor('cb:c1')(element)
    const press = { control: 'Button' as const, gestureId: 'cb:c1', grants: true }
    expect(hook.result.current.admitPress(press)).toBe(true)
    expect(hook.result.current.consumePress()).toBe(false)
    advance(600)
    // A sibling grew and pushed the button down: the window restarts.
    top = 30
    hook.result.current.admitPress(press)
    expect(hook.result.current.consumePress()).toBe(false)
    advance(600)
    expect(hook.result.current.admitPress(press)).toBe(true)
    expect(hook.result.current.consumePress()).toBe(true)
    expect(hook.result.current.consumePress()).toBe(false)
    element.remove()
  })

  it('drops an unsettled Link press before it reaches the guest', async () => {
    const { hook, flushFrame } = setup()
    hook.result.current.channel.onRender({
      document: 'd1',
      revision: 1,
      tree: { type: 'Link', key: '#0', props: { onPress: { $callback: 'c1' } }, children: ['x'] }
    })
    await flushFrame()
    expect(
      hook.result.current.admitPress({ control: 'Link', gestureId: 'cb:c1', grants: true })
    ).toBe(false)
  })

  it('accepts a new guest document from revision 1, but never an older tree of the same one', async () => {
    const { hook, flushFrame } = setup()
    hook.result.current.channel.onRender({ document: 'd1', revision: 7, tree: button('c1') })
    await flushFrame()
    hook.result.current.channel.onRender({ document: 'd1', revision: 1, tree: button('c2') })
    await flushFrame()
    expect(hook.result.current.rendered?.revision).toBe(7)
    hook.result.current.channel.onRender({ document: 'd2', revision: 1, tree: button('c3') })
    await flushFrame()
    expect(hook.result.current.rendered).toMatchObject({
      document: 'd2',
      revision: 1,
      tree: { props: { onPress: { $callback: 'c3' } } }
    })
  })

  it('hands other guest ui.* messages to the panel', () => {
    const onGuestEvent = vi.fn()
    const hook = renderHook(() => usePluginDeclarativeTree(vi.fn(), { onGuestEvent }))
    hook.result.current.channel.onGuestEvent?.('ui.ready', { document: 'd1' })
    expect(onGuestEvent).toHaveBeenCalledWith('ui.ready', { document: 'd1' })
  })
})
