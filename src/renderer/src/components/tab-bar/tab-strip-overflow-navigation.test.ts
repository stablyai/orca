import { describe, expect, it, vi } from 'vitest'
import { scrollTabStripByStep } from './tab-strip-overflow-navigation'

describe('scrollTabStripByStep', () => {
  it('scrolls instantly when requested for drag-hover navigation', () => {
    const scrollBy = vi.fn()
    const el = {
      clientWidth: 200,
      scrollBy
    } as unknown as HTMLElement

    scrollTabStripByStep(el, 'end', 'auto')

    expect(scrollBy).toHaveBeenCalledWith({
      left: 150,
      behavior: 'auto'
    })
  })
})
