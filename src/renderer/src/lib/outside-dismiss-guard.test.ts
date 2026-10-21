import { describe, expect, it, vi } from 'vitest'
import { preventOutsideDismissWhenDirty } from './outside-dismiss-guard'

describe('preventOutsideDismissWhenDirty', () => {
  it('prevents the outside dismiss while the draft is dirty', () => {
    const event = { preventDefault: vi.fn() }

    preventOutsideDismissWhenDirty(() => true)(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('allows the outside dismiss while the draft is clean', () => {
    const event = { preventDefault: vi.fn() }

    preventOutsideDismissWhenDirty(() => false)(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('reads the predicate at event time, not when the handler is created', () => {
    let dirty = false
    const guard = preventOutsideDismissWhenDirty(() => dirty)
    const event = { preventDefault: vi.fn() }

    guard(event)
    dirty = true
    guard(event)

    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
