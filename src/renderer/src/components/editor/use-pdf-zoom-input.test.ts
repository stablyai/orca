// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { replacePdfZoomWheelTarget } from './use-pdf-zoom-input'

describe('replacePdfZoomWheelTarget', () => {
  it('moves the wheel listener when the PDF container is replaced', () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    const firstAdd = vi.spyOn(first, 'addEventListener')
    const firstRemove = vi.spyOn(first, 'removeEventListener')
    const secondAdd = vi.spyOn(second, 'addEventListener')
    const secondRemove = vi.spyOn(second, 'removeEventListener')
    const handleWheel = vi.fn()

    let current = replacePdfZoomWheelTarget(null, first, handleWheel)
    expect(firstAdd).toHaveBeenCalledWith('wheel', handleWheel, { passive: false })

    current = replacePdfZoomWheelTarget(current, second, handleWheel)
    expect(firstRemove).toHaveBeenCalledWith('wheel', handleWheel)
    expect(secondAdd).toHaveBeenCalledWith('wheel', handleWheel, { passive: false })

    current = replacePdfZoomWheelTarget(current, null, handleWheel)
    expect(secondRemove).toHaveBeenCalledWith('wheel', handleWheel)
    expect(current).toBeNull()
  })
})
