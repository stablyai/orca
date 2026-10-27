import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetLayoutFramePositionForTests,
  afterLayoutFrame,
  beginLayoutFramePositions,
  endLayoutFramePositions,
  layoutFramesFlowing,
  noteLayoutFrameEpoch,
  noteLayoutFramePosition
} from './layout-frame-position'

describe('afterLayoutFrame', () => {
  afterEach(() => endLayoutFramePositions())

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

  it('keeps one position per stream: a server’s frames never release this window’s waits', () => {
    const local = vi.fn()
    const server = vi.fn()
    beginLayoutFramePositions()
    beginLayoutFramePositions('env-1')
    afterLayoutFrame(3, local)
    afterLayoutFrame(3, server, 'env-1')

    noteLayoutFramePosition(9, 'env-1')
    expect([local, server].map((run) => run.mock.calls.length)).toEqual([0, 1])
    expect(layoutFramesFlowing('env-1')).toBe(true)
    endLayoutFramePositions('env-1')
    expect(layoutFramesFlowing('env-1')).toBe(false)
    expect(layoutFramesFlowing()).toBe(true)
    endLayoutFramePositions('env-1')
  })

  it('starts a stream’s positions over when its main restarts, showing replies left waiting', () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    beginLayoutFramePositions('env-1')
    noteLayoutFrameEpoch('epoch-1', 'env-1')
    noteLayoutFramePosition(40, 'env-1')
    afterLayoutFrame(41, stale, 'env-1')

    noteLayoutFrameEpoch('epoch-2', 'env-1')
    expect(stale).toHaveBeenCalledTimes(1)
    // The restarted main counts from its own start: seq 2 is ahead of nothing yet.
    afterLayoutFrame(2, fresh, 'env-1')
    expect(fresh).not.toHaveBeenCalled()
    noteLayoutFramePosition(2, 'env-1')
    expect(fresh).toHaveBeenCalledTimes(1)
    endLayoutFramePositions('env-1')
  })
})
