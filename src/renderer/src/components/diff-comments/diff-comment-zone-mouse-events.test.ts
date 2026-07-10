import { describe, expect, it, vi } from 'vitest'
import { installDiffCommentZoneMouseDownStopper } from './diff-comment-zone-mouse-events'

describe('installDiffCommentZoneMouseDownStopper', () => {
  it('removes the mousedown listener on dispose', () => {
    const target = new EventTarget()
    const dispose = installDiffCommentZoneMouseDownStopper(target)

    const first = new Event('mousedown')
    const firstStop = vi.spyOn(first, 'stopPropagation')
    target.dispatchEvent(first)
    expect(firstStop).toHaveBeenCalledOnce()

    dispose()

    const second = new Event('mousedown')
    const secondStop = vi.spyOn(second, 'stopPropagation')
    target.dispatchEvent(second)
    expect(secondStop).not.toHaveBeenCalled()
  })
})
