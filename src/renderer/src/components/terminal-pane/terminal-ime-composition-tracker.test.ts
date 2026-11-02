// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  installTerminalImeCompositionTracker,
  TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS,
  TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS,
  type TerminalImeCompositionTracker
} from './terminal-ime-composition-tracker'

type TrackerHarness = {
  tracker: TerminalImeCompositionTracker
  element: HTMLElement
  advance: (ms: number) => void
  composition: (
    type: 'compositionstart' | 'compositionupdate' | 'compositionend',
    data: string
  ) => void
  input: (inputType: string) => void
  blur: () => void
}

function installTracker(): TrackerHarness {
  let now = 0
  const element = document.createElement('div')
  const tracker = installTerminalImeCompositionTracker(element, { now: () => now })
  return {
    tracker,
    element,
    advance: (ms) => {
      now += ms
    },
    composition: (type, data) => {
      const event = new CompositionEvent(type, { bubbles: true })
      Object.defineProperty(event, 'data', { value: data })
      element.dispatchEvent(event)
    },
    input: (inputType) => {
      element.dispatchEvent(new InputEvent('input', { inputType, bubbles: true }))
    },
    blur: () => {
      element.dispatchEvent(new Event('blur', { bubbles: true }))
    }
  }
}

describe('installTerminalImeCompositionTracker', () => {
  it('keeps composition active through Sogou-style empty compositionupdate', () => {
    const harness = installTracker()
    harness.composition('compositionstart', '')
    harness.composition('compositionupdate', 'ni')
    harness.composition('compositionupdate', '')
    expect(harness.tracker.isActive()).toBe(true)
  })

  describe('candidate key guard', () => {
    it('expires after prolonged composition-event silence so stale IME state cannot keep terminal keys dead', () => {
      const harness = installTracker()
      harness.composition('compositionstart', '')
      harness.advance(TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS)
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(true)
      expect(harness.tracker.isActive()).toBe(true)
      harness.advance(1)
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(false)
      expect(harness.tracker.isActive()).toBe(false)
    })

    it('refreshes the expiry window on composition activity', () => {
      const harness = installTracker()
      harness.composition('compositionstart', '')
      harness.advance(TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS)
      harness.composition('compositionupdate', '')
      harness.advance(TERMINAL_IME_CANDIDATE_GUARD_STALE_COMPOSITION_EXPIRY_MS)
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(true)
    })

    it('does not arm the post-composition window without Sogou-style empty updates', () => {
      const harness = installTracker()
      harness.composition('compositionstart', '')
      harness.composition('compositionupdate', '你')
      harness.composition('compositionend', '你')
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(false)
    })

    it('absorbs the Sogou-style committing key after compositionend, then expires', () => {
      const harness = installTracker()
      harness.composition('compositionstart', '')
      harness.composition('compositionupdate', '你')
      harness.composition('compositionupdate', '')
      harness.composition('compositionend', '你')
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(true)
      harness.advance(TERMINAL_IME_CANDIDATE_GUARD_POST_COMPOSITION_MS)
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(true)
      harness.advance(1)
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(false)
    })

    it('drops the post-composition window once ordinary typing resumes', () => {
      const harness = installTracker()
      harness.composition('compositionstart', '')
      harness.composition('compositionupdate', '')
      harness.composition('compositionend', '你')
      harness.input('insertText')
      expect(harness.tracker.isCandidateKeyGuardActive()).toBe(false)
    })
  })

  it('stops tracking after dispose', () => {
    const harness = installTracker()
    harness.tracker.dispose()
    harness.composition('compositionstart', '')
    expect(harness.tracker.isActive()).toBe(false)
  })
})
