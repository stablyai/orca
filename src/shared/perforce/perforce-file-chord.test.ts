import { describe, expect, it } from 'vitest'
import { PerforceChordDetector, type PerforceChordKeyEvent } from './perforce-file-chord'

const key = (code: string, patch: Partial<PerforceChordKeyEvent> = {}): PerforceChordKeyEvent => ({
  code,
  alt: true,
  control: false,
  meta: false,
  shift: false,
  isAutoRepeat: false,
  ...patch
})

describe('PerforceChordDetector', () => {
  it('completes Alt+P then Alt+E as edit and Alt+P then Alt+R as revert', () => {
    const detector = new PerforceChordDetector()
    expect(detector.process(key('KeyP'), 0, true)).toEqual({ type: 'armed' })
    expect(detector.process(key('KeyE'), 100, true)).toEqual({ type: 'action', action: 'edit' })
    detector.process(key('KeyP'), 200, true)
    expect(detector.process(key('KeyR'), 300, true)).toEqual({ type: 'action', action: 'revert' })
  })

  it('needs the leader first and disarms after any other key', () => {
    const detector = new PerforceChordDetector()
    expect(detector.process(key('KeyE'), 0, true)).toBeNull()
    detector.process(key('KeyP'), 10, true)
    expect(detector.process(key('KeyX'), 20, true)).toBeNull()
    expect(detector.process(key('KeyE'), 30, true)).toBeNull()
  })

  it('expires the leader after the window', () => {
    const detector = new PerforceChordDetector()
    detector.process(key('KeyP'), 0, true)
    expect(detector.process(key('KeyE'), 2500, true)).toBeNull()
  })

  it('does not claim the leader when no Perforce file is active', () => {
    const detector = new PerforceChordDetector()
    expect(detector.process(key('KeyP'), 0, false)).toBeNull()
    expect(detector.process(key('KeyE'), 10, false)).toBeNull()
  })

  it('ignores other modifiers, auto-repeat, and bare modifier presses', () => {
    const detector = new PerforceChordDetector()
    expect(detector.process(key('KeyP', { shift: true }), 0, true)).toBeNull()
    detector.process(key('KeyP'), 10, true)
    expect(detector.process(key('AltLeft'), 20, true)).toBeNull()
    expect(detector.process(key('KeyE', { isAutoRepeat: true }), 30, true)).toBeNull()
    expect(detector.process(key('KeyE'), 40, true)).toEqual({ type: 'action', action: 'edit' })
  })
})
