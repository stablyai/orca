import { describe, expect, it } from 'vitest'

import { getPageNumbers } from './task-page-pagination-page-numbers'

describe('getPageNumbers', () => {
  it('lists every zero-based page when the total fits the no-ellipsis threshold', () => {
    expect(getPageNumbers(0, 1)).toEqual([0])
    expect(getPageNumbers(4, 9)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('returns an empty list when there are no pages', () => {
    expect(getPageNumbers(0, 0)).toEqual([])
  })

  it('collapses the tail when the current page is near the start', () => {
    expect(getPageNumbers(0, 20)).toEqual([0, 1, 2, 'ellipsis', 19])
  })

  it('collapses the head when the current page is near the end', () => {
    expect(getPageNumbers(19, 20)).toEqual([0, 'ellipsis', 17, 18, 19])
  })

  it('collapses both sides around a middle page', () => {
    expect(getPageNumbers(10, 20)).toEqual([0, 'ellipsis', 8, 9, 10, 11, 12, 'ellipsis', 19])
  })

  it('omits the ellipsis when the window is exactly adjacent to an edge', () => {
    // characterization: current behavior — a gap of exactly 1 is not elided.
    expect(getPageNumbers(3, 10)).toEqual([0, 1, 2, 3, 4, 5, 'ellipsis', 9])
  })

  it('drops the window entirely when the current page is out of range', () => {
    // characterization: the window bounds cross over rather than clamping, so only
    // the first and last pages survive.
    expect(getPageNumbers(-5, 12)).toEqual([0, 'ellipsis', 11])
    expect(getPageNumbers(100, 12)).toEqual([0, 'ellipsis', 11])
  })
})
