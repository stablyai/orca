import { describe, expect, it } from 'vitest'
import {
  NativeChatVideoSnapshots,
  nativeChatSameVideoFrame,
  nativeChatVideoContentRect,
  nativeChatVideoNoteTime,
  nativeChatVideoSeekable
} from './native-chat-video-frames'

const snap = (time: number) => ({ time, png: new Blob(['png']), width: 4, height: 3 })

describe('nativeChatVideoContentRect', () => {
  it('finds the picture inside letterbox bars, either way round', () => {
    // A wide video in a tall box: bars above and below.
    expect(
      nativeChatVideoContentRect({ width: 400, height: 400 }, { width: 1600, height: 900 })
    ).toEqual({
      x: 0,
      y: 87.5,
      width: 400,
      height: 225
    })
    // A tall video in a wide box: bars at the sides.
    expect(
      nativeChatVideoContentRect({ width: 800, height: 400 }, { width: 400, height: 800 })
    ).toEqual({
      x: 300,
      y: 0,
      width: 200,
      height: 400
    })
    expect(
      nativeChatVideoContentRect({ width: 800, height: 400 }, { width: 0, height: 0 }).width
    ).toBe(0)
  })
})

describe('video note times', () => {
  it('keeps the playhead to the millisecond and treats a few hundredths apart as one frame', () => {
    expect(nativeChatVideoNoteTime(2.123456)).toBe(2.123)
    expect(nativeChatSameVideoFrame(2, 2.015)).toBe(true)
    expect(nativeChatSameVideoFrame(2, 2.05)).toBe(false)
    expect(nativeChatSameVideoFrame(undefined, 2)).toBe(false)
  })

  it('can move only in a video whose length is known', () => {
    expect(nativeChatVideoSeekable({ duration: 12 })).toBe(true)
    expect(nativeChatVideoSeekable({ duration: Number.POSITIVE_INFINITY })).toBe(false)
    expect(nativeChatVideoSeekable({ duration: Number.NaN })).toBe(false)
  })
})

describe('NativeChatVideoSnapshots', () => {
  it('keeps every frame a note is on and the newest, and drops other unused ones', () => {
    const frames = new NativeChatVideoSnapshots()
    frames.add(snap(1), [])
    frames.add(snap(2), [1])
    // Frame 3 is captured but 2 has no note: 2 goes, 1 (used) and 3 (newest) stay.
    frames.add(snap(3), [1])
    expect(frames.find(1)).toBeDefined()
    expect(frames.find(2)).toBeUndefined()
    expect(frames.find(3)).toBeDefined()
    // Recapturing a frame replaces it rather than adding a second.
    frames.add(snap(3.01), [1, 3])
    expect(frames.size).toBe(2)
  })

  it('never holds more than a message’s frames plus the newest', () => {
    const frames = new NativeChatVideoSnapshots()
    const used: number[] = []
    for (let time = 0; time < 12; time += 1) {
      used.push(time)
      frames.add(snap(time), used)
    }
    expect(frames.size).toBe(9)
    expect(frames.find(11)).toBeDefined()
  })
})
