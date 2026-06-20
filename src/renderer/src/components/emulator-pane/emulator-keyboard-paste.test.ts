// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  buildEmulatorKeyboardPastePlan,
  EMULATOR_KEYBOARD_PASTE_MAX_BYTES,
  iterateEmulatorKeyboardPasteChunks,
  pasteTextIntoEmulatorKeyboard
} from './emulator-keyboard-paste'

describe('emulator keyboard paste', () => {
  it('splits accepted text into bounded keyboard-frame chunks', () => {
    const plan = buildEmulatorKeyboardPastePlan('ab\r\nc', { maxFramesPerChunk: 4 })

    expect(plan.status).toBe('accepted')
    if (plan.status !== 'accepted') {
      return
    }
    expect(plan.chunks.map((chunk) => chunk.length)).toEqual([4, 4])
    expect(plan.chunks.every((chunk) => chunk.length <= 4)).toBe(true)
  })

  it('keeps planned chunks aligned with lazy keyboard-frame chunks', () => {
    const plan = buildEmulatorKeyboardPastePlan('ab\r\nc', { maxFramesPerChunk: 4 })

    expect(plan.status).toBe('accepted')
    if (plan.status !== 'accepted') {
      return
    }
    expect(plan.chunks).toEqual([...iterateEmulatorKeyboardPasteChunks('ab\r\nc', 4)])
  })

  it('rejects oversized text before building keyboard frames', () => {
    const plan = buildEmulatorKeyboardPastePlan('a'.repeat(EMULATOR_KEYBOARD_PASTE_MAX_BYTES + 1))

    expect(plan).toEqual({
      byteLength: EMULATOR_KEYBOARD_PASTE_MAX_BYTES + 1,
      reason: 'too-large',
      status: 'rejected'
    })
  })

  it('rejects oversized text before validating later unsupported characters', () => {
    const oversizedText = 'a'.repeat(EMULATOR_KEYBOARD_PASTE_MAX_BYTES + 1)
    const plan = buildEmulatorKeyboardPastePlan(`${oversizedText}🙂`)

    expect(plan).toEqual({
      byteLength: EMULATOR_KEYBOARD_PASTE_MAX_BYTES + 1,
      reason: 'too-large',
      status: 'rejected'
    })
  })

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

  it('sends chunks only after the previous chunk delay elapses', async () => {
    vi.useFakeTimers()
    const sendKeyboardFrames = vi.fn(() => true)
    const resultPromise = pasteTextIntoEmulatorKeyboard({
      frameDelayMs: 5,
      maxFramesPerChunk: 2,
      sendKeyboardFrames,
      text: 'abc'
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(sendKeyboardFrames).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10)
    expect(sendKeyboardFrames).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(10)
    await expect(resultPromise).resolves.toEqual({
      byteLength: 3,
      chunkCount: 3,
      status: 'sent'
    })
    expect(sendKeyboardFrames).toHaveBeenCalledTimes(3)
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
    expect(sendKeyboardFrames).toHaveBeenCalledTimes(1)
  })

  it('reports target-unavailable without retrying through another path', async () => {
    const sendKeyboardFrames = vi.fn(() => false)

    await expect(
      pasteTextIntoEmulatorKeyboard({ sendKeyboardFrames, text: 'abc' })
    ).resolves.toEqual({
      byteLength: 3,
      reason: 'target-unavailable',
      status: 'rejected'
    })
    expect(sendKeyboardFrames).toHaveBeenCalledTimes(1)
  })
})
