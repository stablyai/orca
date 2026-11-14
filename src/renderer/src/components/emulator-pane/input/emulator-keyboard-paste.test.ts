// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  buildEmulatorKeyboardPastePlan,
  pasteTextIntoEmulatorKeyboard
} from './emulator-keyboard-paste'

describe('emulator keyboard paste', () => {
  it('rejects unsupported text without exposing pasted content', () => {
    const plan = buildEmulatorKeyboardPastePlan('token=secret🙂')

    expect(plan).toEqual({
      byteLength: 16,
      reason: 'unsupported-text',
      status: 'rejected'
    })
    expect(JSON.stringify(plan)).not.toContain('token')
    expect(JSON.stringify(plan)).not.toContain('secret')
  })

  it('rejects a later unsupported character before sending any keyboard frames', async () => {
    const sendKeyboardFrames = vi.fn(() => true)

    await expect(
      pasteTextIntoEmulatorKeyboard({
        sendKeyboardFrames,
        text: 'abc🙂'
      })
    ).resolves.toEqual({
      byteLength: 7,
      reason: 'unsupported-text',
      status: 'rejected'
    })
    expect(sendKeyboardFrames).not.toHaveBeenCalled()
  })

  it('cancels before sending the next chunk', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const sendKeyboardFrames = vi.fn(() => true)
    const resultPromise = pasteTextIntoEmulatorKeyboard({
      frameDelayMs: 5,
      isCancelled: () => cancelled,
      maxFramesPerChunk: 2,
      sendKeyboardFrames,
      text: 'abc'
    })

    await vi.advanceTimersByTimeAsync(0)
    cancelled = true
    await vi.advanceTimersByTimeAsync(10)

    await expect(resultPromise).resolves.toEqual({
      byteLength: 3,
      reason: 'cancelled',
      status: 'cancelled'
    })
  })
})
