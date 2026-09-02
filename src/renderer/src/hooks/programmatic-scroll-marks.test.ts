import { describe, expect, it } from 'vitest'
import { createProgrammaticScrollMarks } from './programmatic-scroll-marks'

const scrollEvent = (): Event => new Event('scroll')

describe('createProgrammaticScrollMarks', () => {
  it('classifies an event matching a marked target as programmatic', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(500)
    expect(marks.consume(scrollEvent(), 500, 10_000)).toBe(true)
  })

  it('matches within the epsilon for fractional scroll positions', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(500)
    expect(marks.consume(scrollEvent(), 501.6, 10_000)).toBe(true)
  })

  it('classifies an unmarked scroll as user input', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(500)
    expect(marks.consume(scrollEvent(), 660, 10_000)).toBe(false)
  })

  it('treats a clamped landing of an out-of-range write as programmatic', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(12_000)
    expect(marks.consume(scrollEvent(), 8_000, 8_000)).toBe(true)
  })

  it('does not treat a user scroll to the bottom as a clamped write', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(4_000)
    expect(marks.consume(scrollEvent(), 8_000, 8_000)).toBe(false)
  })

  it('returns the same classification for the same event across listeners', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(500)
    const event = scrollEvent()
    expect(marks.consume(event, 500, 10_000)).toBe(true)
    // Second listener on the same event: mark already consumed, cache must answer.
    expect(marks.consume(event, 500, 10_000)).toBe(true)
    // A fresh event at the same offset is a new scroll and no mark remains.
    expect(marks.consume(scrollEvent(), 500, 10_000)).toBe(false)
  })

  it('drops older marks whose events were coalesced away', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(300)
    marks.mark(700)
    expect(marks.consume(scrollEvent(), 700, 10_000)).toBe(true)
    // The 300 mark predates the matched write; it must not claim a later user scroll.
    expect(marks.consume(scrollEvent(), 300, 10_000)).toBe(false)
  })

  it('consumes marks independently when events arrive in write order', () => {
    const marks = createProgrammaticScrollMarks()
    marks.mark(300)
    marks.mark(700)
    expect(marks.consume(scrollEvent(), 300, 10_000)).toBe(true)
    expect(marks.consume(scrollEvent(), 700, 10_000)).toBe(true)
    expect(marks.consume(scrollEvent(), 700, 10_000)).toBe(false)
  })

  it('bounds the pending queue', () => {
    const marks = createProgrammaticScrollMarks()
    for (let i = 0; i < 40; i++) {
      marks.mark(i * 1_000)
    }
    // Oldest marks were evicted; only the most recent 16 remain matchable.
    expect(marks.consume(scrollEvent(), 0, 100_000)).toBe(false)
    expect(marks.consume(scrollEvent(), 39_000, 100_000)).toBe(true)
  })
})
