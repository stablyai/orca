import { describe, expect, it } from 'vitest'
import { shouldCancelVirtualizedScrollOffsetRestore } from './virtualizedScrollOffsetRestore'

describe('shouldCancelVirtualizedScrollOffsetRestore', () => {
  it('keeps a pending restore when direct user scroll input is not tracked', () => {
    expect(
      shouldCancelVirtualizedScrollOffsetRestore({
        restoring: true
      })
    ).toBe(false)
  })

  it('keeps a pending restore during programmatic scroll movement', () => {
    expect(
      shouldCancelVirtualizedScrollOffsetRestore({
        hasDirectScrollInput: () => false,
        restoring: true
      })
    ).toBe(false)
  })

  it('does not cancel when there is no pending restore', () => {
    expect(
      shouldCancelVirtualizedScrollOffsetRestore({
        hasDirectScrollInput: () => true,
        restoring: false
      })
    ).toBe(false)
  })

  it('cancels a pending restore while direct user scroll input is active', () => {
    expect(
      shouldCancelVirtualizedScrollOffsetRestore({
        hasDirectScrollInput: () => true,
        restoring: true
      })
    ).toBe(true)
  })
})
