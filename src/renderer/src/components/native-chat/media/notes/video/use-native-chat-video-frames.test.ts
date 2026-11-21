// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatMediaNote } from '../native-chat-media-notes'
import {
  NativeChatVideoFrameUnavailable,
  nativeChatVideoNotesAsText,
  useNativeChatVideoFrames
} from './use-native-chat-video-frames'

const captureFrame = vi.fn(async () => new Uint8Array([137, 80, 78, 71]))
const closed = vi.fn()

beforeEach(() => {
  captureFrame.mockClear()
  closed.mockClear()
  Object.assign(window, { api: { nativeChat: { captureFrame } } })
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 960, height: 540, close: closed }))
  )
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
})
afterEach(() => vi.unstubAllGlobals())

function setup(duration = 4) {
  const video = document.createElement('video')
  Object.defineProperty(video, 'duration', { value: duration })
  Object.defineProperty(video, 'paused', { value: true })
  video.pause = vi.fn()
  const layer = document.createElement('div')
  layer.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 10.4, y: 20.6, width: 640, height: 360 })
  const notes: NativeChatMediaNote[] = []
  const hook = renderHook(() =>
    useNativeChatVideoFrames({ video: { current: video }, layer: { current: layer }, notes })
  )
  return { video, hook }
}

it('captures each frame once, from the picture’s whole pixels', async () => {
  const { video, hook } = setup()
  video.currentTime = 1
  await act(async () => {
    expect(await hook.result.current.ensure(1)).toBe(true)
  })
  // Inset to whole pixels so no letterbox edge is in the frame.
  expect(captureFrame).toHaveBeenCalledWith({ x: 11, y: 21, width: 639, height: 359 })
  await act(async () => {
    expect(await hook.result.current.ensure(1.01)).toBe(true)
  })
  expect(captureFrame).toHaveBeenCalledTimes(1)
})

it('drops a capture whose frame moved away while it ran', async () => {
  const { video, hook } = setup()
  video.currentTime = 1
  captureFrame.mockImplementationOnce(async () => {
    video.currentTime = 2.5
    return new Uint8Array([1])
  })
  await act(async () => {
    expect(await hook.result.current.ensure(1)).toBe(false)
  })
  expect(hook.result.current.held).toHaveLength(0)
})

it('draws each note on its own captured frame, and frees it after', async () => {
  const { video, hook } = setup()
  video.currentTime = 2
  await act(async () => {
    await hook.result.current.ensure(2)
  })
  const frame = await hook.result.current.frame(2)
  expect(frame).toMatchObject({ width: 960, height: 540 })
  frame.release?.()
  expect(closed).toHaveBeenCalled()
})

it('moves a video to a note’s time to capture a frame it no longer holds', async () => {
  const { video, hook } = setup()
  video.currentTime = 0
  const seeking = act(async () => {
    const frame = await hook.result.current.frame(3)
    expect(frame.width).toBe(960)
  })
  await vi.waitFor(() => expect(video.currentTime).toBe(3))
  video.dispatchEvent(new Event('seeked'))
  await seeking
  expect(captureFrame).toHaveBeenCalledTimes(1)
})

it('a recording with no known length can’t give back a frame it no longer holds', async () => {
  const { hook } = setup(Number.POSITIVE_INFINITY)
  await expect(hook.result.current.frame(3)).rejects.toBeInstanceOf(NativeChatVideoFrameUnavailable)
  expect(captureFrame).not.toHaveBeenCalled()
})

it('writes notes whose frames are gone as numbered text with their times', () => {
  const notes: NativeChatMediaNote[] = [
    { id: 'b', number: 2, text: 'Second\nline', mark: { kind: 'pin', x: 0, y: 0 }, time: 3.25 },
    { id: 'a', number: 1, text: 'First', mark: { kind: 'pin', x: 0, y: 0 }, time: 1 }
  ]
  expect(nativeChatVideoNotesAsText('live.webm', notes)).toBe(
    "Notes on live.webm (its frames couldn't be attached):\n1. First (at 0:01.0)\n2. Second line (at 0:03.2)"
  )
})
