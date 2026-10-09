// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNativeChatReplyReveals } from './native-chat-reply-reveals'

afterEach(cleanup)

function windowAt(start: number): string[] {
  return Array.from({ length: 300 }, (_, index) => `row-${start + index}`)
}

describe('transcript reply reveal retention', () => {
  it('shows initial history immediately and begins only a newly arriving tail reply', () => {
    const view = renderHook(({ rows }) => useNativeChatReplyReveals(rows, new Set(rows)), {
      initialProps: { rows: ['user', 'existing'] }
    })
    expect(view.result.current.begun.size).toBe(0)
    view.rerender({ rows: ['older', 'user', 'existing'] })
    expect(view.result.current.begun.size).toBe(0)
    view.rerender({ rows: ['older', 'user', 'existing', 'reply'] })
    expect([...view.result.current.begun]).toEqual(['reply'])
  })

  it('does not replay a loaded reply after its section closes and reopens', () => {
    const loaded = new Set(['user', 'child-reply'])
    const view = renderHook(({ rows }) => useNativeChatReplyReveals(rows, loaded), {
      initialProps: { rows: ['user'] }
    })
    view.rerender({ rows: ['user', 'child-reply'] })
    expect(view.result.current.begun.has('child-reply')).toBe(true)
    view.result.current.drawn.set('child-reply', {
      source: 'received',
      shown: 3,
      arrivals: [{ from: 3, to: 8, at: 0 }]
    })
    view.rerender({ rows: ['user'] })
    expect(view.result.current.begun.size).toBe(0)
    expect(view.result.current.drawn.size).toBe(0)
    view.rerender({ rows: ['user', 'child-reply'] })
    expect(view.result.current.begun.size).toBe(0)
  })

  it('retires hidden replies when the loaded inventory changes without changing visible rows', () => {
    const rows = ['user']
    const view = renderHook(({ visible, loaded }) => useNativeChatReplyReveals(visible, loaded), {
      initialProps: { visible: rows, loaded: new Set(['user', 'child-reply']) }
    })
    view.rerender({ visible: ['user', 'child-reply'], loaded: new Set(['user', 'child-reply']) })
    view.rerender({ visible: rows, loaded: new Set(['user', 'child-reply']) })
    view.rerender({ visible: rows, loaded: new Set(['user']) })
    view.rerender({ visible: ['user', 'child-reply'], loaded: new Set(['user', 'child-reply']) })
    expect([...view.result.current.begun]).toEqual(['child-reply'])
  })

  it('remembers a folded reply as the rest of the loaded history window advances', () => {
    const view = renderHook(
      ({ rows }) => useNativeChatReplyReveals(rows, new Set(['child-reply', ...rows])),
      { initialProps: { rows: ['user', 'child-reply'] } }
    )
    for (let window = 0; window < 10; window += 1) {
      view.rerender({ rows: windowAt(window * 300) })
    }
    view.rerender({ rows: [...windowAt(2700), 'child-reply'] })
    expect(view.result.current.begun.has('child-reply')).toBe(false)
  })

  it('forgets rows that left the loaded history', () => {
    const view = renderHook(({ rows }) => useNativeChatReplyReveals(rows, new Set(rows)), {
      initialProps: { rows: windowAt(0) }
    })
    view.rerender({ rows: windowAt(300) })
    // A retired row returning at the tail is new to this transcript, so it begins.
    view.rerender({ rows: [...windowAt(300), 'row-0'] })
    expect(view.result.current.begun.has('row-0')).toBe(true)
    view.rerender({ rows: [...windowAt(300), 'row-299'] })
    expect(view.result.current.begun.has('row-299')).toBe(true)
    // With nothing loaded nothing is remembered, so what loads next is history, not a new reply.
    view.rerender({ rows: [] })
    view.rerender({ rows: ['row-600', 'row-601'] })
    expect(view.result.current.begun.size).toBe(0)
  })
})
