import { describe, expect, it } from 'vitest'
import { middleEllipsis } from './middle-ellipsis'

const upTo =
  (chars: number) =>
  (candidate: string): boolean =>
    candidate.length <= chars

describe('middleEllipsis', () => {
  it('keeps a label that fits', () => {
    expect(middleEllipsis('Local Mac', upTo(9))).toBe('Local Mac')
  })

  it('keeps an even start and end around the ellipsis', () => {
    expect(middleEllipsis('build-runner-02.eu-west.internal', upTo(15))).toBe('build-r…nternal')
    expect(middleEllipsis('build-runner-02.eu-west.internal', upTo(16))).toBe('build-r…internal')
  })

  it('falls back to the ellipsis alone when nothing else fits', () => {
    expect(middleEllipsis('build-runner', upTo(1))).toBe('…')
  })
})
