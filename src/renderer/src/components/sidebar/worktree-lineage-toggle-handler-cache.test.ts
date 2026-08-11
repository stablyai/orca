import { describe, expect, it, vi } from 'vitest'
import type React from 'react'
import { createLineageToggleHandlerCache } from './worktree-lineage-toggle-handler-cache'

const makeEvent = (): React.MouseEvent<HTMLButtonElement> =>
  ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }) as unknown as React.MouseEvent<HTMLButtonElement>

describe('createLineageToggleHandlerCache', () => {
  it('returns a referentially stable handler for the same group key across calls', () => {
    const getHandler = createLineageToggleHandlerCache(vi.fn())

    const first = getHandler('lineage:alpha')
    const second = getHandler('lineage:alpha')

    // Why: stable identity is what lets React.memo'd WorktreeCard bail out.
    expect(second).toBe(first)
  })

  it('returns distinct handlers for distinct group keys', () => {
    const getHandler = createLineageToggleHandlerCache(vi.fn())

    expect(getHandler('lineage:alpha')).not.toBe(getHandler('lineage:beta'))
  })

  it('prevents default, stops propagation, and toggles the bound group key', () => {
    const toggleGroup = vi.fn()
    const getHandler = createLineageToggleHandlerCache(toggleGroup)
    const event = makeEvent()

    getHandler('lineage:alpha')(event)

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(toggleGroup).toHaveBeenCalledExactlyOnceWith('lineage:alpha')
  })

  it('keeps each cached handler bound to its own group key', () => {
    const toggleGroup = vi.fn()
    const getHandler = createLineageToggleHandlerCache(toggleGroup)

    getHandler('lineage:beta')(makeEvent())

    expect(toggleGroup).toHaveBeenCalledExactlyOnceWith('lineage:beta')
  })
})
