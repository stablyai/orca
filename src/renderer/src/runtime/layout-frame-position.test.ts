import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLayoutFramePositionForTests,
  afterLayoutFrame,
  beginLayoutFramePositions,
  endLayoutFramePositions,
  layoutFramesFlowing,
  noteLayoutFramePosition
} from './layout-frame-position'

describe('afterLayoutFrame', () => {
  afterEach(() => endLayoutFramePositions())

  it('runs at once once the stream ended, or for a reply that names no frame', () => {
    endLayoutFramePositions()
    const run = vi.fn()
    afterLayoutFrame(9, run)
    expect(run).toHaveBeenCalledTimes(1)

    noteLayoutFramePosition(3)
    afterLayoutFrame(undefined, run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('runs at once while the window has opened no stream', () => {
    _resetLayoutFramePositionForTests()
    const run = vi.fn()
    afterLayoutFrame(2, run)
    expect(run).toHaveBeenCalledOnce()
    expect(layoutFramesFlowing()).toBe(false)
  })

  it('waits for an opened stream before its first frame: that frame, or its end', () => {
    _resetLayoutFramePositionForTests()
    beginLayoutFramePositions()
    const framed = vi.fn()
    afterLayoutFrame(2, framed)
    expect(framed).not.toHaveBeenCalled()
    noteLayoutFramePosition(2)
    expect(framed).toHaveBeenCalledOnce()

    _resetLayoutFramePositionForTests()
    beginLayoutFramePositions()
    const ended = vi.fn()
    afterLayoutFrame(2, ended)
    expect(layoutFramesFlowing()).toBe(true)
    endLayoutFramePositions()
    expect(ended).toHaveBeenCalledOnce()
    expect(layoutFramesFlowing()).toBe(false)
  })

  it('runs once the window holds the named frame, in the order frames come in', () => {
    noteLayoutFramePosition(3)
    const order: string[] = []
    afterLayoutFrame(3, () => order.push('held'))
    afterLayoutFrame(5, () => order.push('five'))
    afterLayoutFrame(4, () => order.push('four'))
    expect(order).toEqual(['held'])

    noteLayoutFramePosition(4)
    expect(order).toEqual(['held', 'four'])
    // A frame older than the position moves nothing back.
    noteLayoutFramePosition(2)
    afterLayoutFrame(4, () => order.push('four again'))
    noteLayoutFramePosition(5)
    expect(order).toEqual(['held', 'four', 'four again', 'five'])
  })

  it('runs every waiter when the stream ends, and a throwing one does not stop the rest', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    noteLayoutFramePosition(1)
    const run = vi.fn()
    afterLayoutFrame(2, () => {
      throw new Error('boom')
    })
    afterLayoutFrame(8, run)

    endLayoutFramePositions()

    expect(run).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    // Nothing is open now, so a later reply does not wait.
    afterLayoutFrame(20, run)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
