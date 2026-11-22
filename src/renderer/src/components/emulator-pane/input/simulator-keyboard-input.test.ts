import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HeldSimulatorInput,
  simulatorKeyFrames,
  type HeldSimulatorInputSinks,
  type SimulatorKeyPress
} from './simulator-keyboard-input'

const FRAME_GAP_MS = 4

function press(
  key: string,
  code: string,
  init: Partial<SimulatorKeyPress> = {}
): SimulatorKeyPress {
  return { alt: false, capsLetter: false, code, key, shift: false, ...init }
}

// What reached the simulator, in order: "key:<usage>" per key press and "text:<text>" per commit.
let delivered: string[]
let physicalKeys: boolean

function sinks(): HeldSimulatorInputSinks {
  return {
    keyFrames: (keyPress) => simulatorKeyFrames(keyPress, physicalKeys),
    sendFrames: (frames) => {
      // Frames go out spaced, like the serve-sim socket sends them.
      for (const [index, frame] of frames.entries()) {
        setTimeout(() => {
          if (frame.type === 'down' && frame.usage < 0xe0) {
            delivered.push(`key:${frame.usage}`)
          }
        }, index * FRAME_GAP_MS)
      }
      return (frames.length - 1) * FRAME_GAP_MS
    },
    // A commit through main takes a while, then settles.
    typeText: (text) => {
      delivered.push(`text:${text}`)
      // ast-grep-ignore: test-no-real-time-wait -- runs under vi.useFakeTimers; it models a slow commit.
      return new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
  }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5000)
}

beforeEach(() => {
  vi.useFakeTimers()
  delivered = []
  physicalKeys = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('HeldSimulatorInput', () => {
  it('types Option text held behind a commit instead of dropping it', async () => {
    const input = new HeldSimulatorInput()
    input.commitText('你好', sinks())
    // Mac Option+2 is "™"; a simulator on its US layout has no key for it.
    for (const keyPress of [
      press('a', 'KeyA'),
      press('™', 'Digit2', { alt: true }),
      press('b', 'KeyB')
    ]) {
      expect(input.pressKey(keyPress, sinks())).toBe('held')
    }
    await settle()

    expect(delivered).toEqual(['text:你好', 'key:4', 'text:™', 'key:5'])
  })

  it('types a commit only after the keys before it have all gone out', async () => {
    const input = new HeldSimulatorInput()
    input.commitText('你', sinks())
    for (const key of 'abcdef') {
      input.pressKey(press(key, `Key${key.toUpperCase()}`), sinks())
    }
    input.commitText('好', sinks())
    await settle()

    expect(delivered).toEqual([
      'text:你',
      'key:4',
      'key:5',
      'key:6',
      'key:7',
      'key:8',
      'key:9',
      'text:好'
    ])
  })

  it('waits for a key sent just before a commit to finish going out', async () => {
    const input = new HeldSimulatorInput()
    // Shift+A goes out as four spaced frames.
    expect(input.pressKey(press('A', 'KeyA', { shift: true }), sinks())).toBe('sent')
    input.commitText('你好', sinks())
    await settle()

    expect(delivered).toEqual(['key:4', 'text:你好'])
  })

  it('types a key held across a layout change as the character it was typed as', async () => {
    physicalKeys = true
    const input = new HeldSimulatorInput()
    input.commitText('你好', sinks())
    // French AZERTY: the key US calls Q types "a". The Mac then switches to US mid-commit.
    input.pressKey(press('a', 'KeyQ'), sinks())
    input.pressKey(press('Backspace', 'Backspace'), sinks())
    input.startSync()
    input.pressKey(press('q', 'KeyQ'), sinks())
    input.finishSync(sinks())
    await settle()

    expect(delivered).toEqual(['text:你好', 'text:a', 'key:42', 'key:20'])
  })

  it('holds a key pressed while released keys are still going out', async () => {
    const input = new HeldSimulatorInput()
    input.commitText('你', sinks())
    for (const key of 'abc') {
      input.pressKey(press(key, `Key${key.toUpperCase()}`), sinks())
    }
    // The commit settles and releases a-b-c as spaced frames; d is typed before they finish.
    await vi.advanceTimersByTimeAsync(100)
    expect(input.pressKey(press('d', 'KeyD'), sinks())).toBe('held')
    await settle()

    expect(delivered).toEqual(['text:你', 'key:4', 'key:5', 'key:6', 'key:7'])
  })

  it('types a held key with a combining mark as text', async () => {
    const input = new HeldSimulatorInput()
    input.commitText('你', sinks())
    input.pressKey(press('ḍ̇', 'KeyD', { alt: true }), sinks())
    await settle()

    expect(delivered).toEqual(['text:你', 'text:ḍ̇'])
  })

  it('releases keys held by a layout sync only after earlier frames have gone out', async () => {
    const input = new HeldSimulatorInput()
    // Shift+A goes out as four spaced frames; the sync starts and ends while they do.
    input.pressKey(press('A', 'KeyA', { shift: true }), sinks())
    input.startSync()
    input.pressKey(press('b', 'KeyB'), sinks())
    input.finishSync(sinks())
    await settle()

    expect(delivered).toEqual(['key:4', 'key:5'])
  })
})
