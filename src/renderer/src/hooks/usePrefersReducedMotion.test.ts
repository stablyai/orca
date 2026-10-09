import { afterEach, describe, expect, it, vi } from 'vitest'
import { motionSafeScrollBehavior } from './usePrefersReducedMotion'

function stubReducedMotion(reduce: boolean): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)'
  }))
  vi.stubGlobal('window', { matchMedia })
  return matchMedia
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('motionSafeScrollBehavior', () => {
  it('jumps instead of smooth-scrolling when reduced motion is on', () => {
    const matchMedia = stubReducedMotion(true)

    expect(motionSafeScrollBehavior()).toBe('auto')
    expect(motionSafeScrollBehavior('smooth')).toBe('auto')
    expect(motionSafeScrollBehavior('instant')).toBe('instant')
    expect(motionSafeScrollBehavior('auto')).toBe('auto')
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
  })

  it('keeps the requested behavior when reduced motion is off', () => {
    stubReducedMotion(false)

    expect(motionSafeScrollBehavior()).toBe('smooth')
    expect(motionSafeScrollBehavior('smooth')).toBe('smooth')
    expect(motionSafeScrollBehavior('instant')).toBe('instant')
  })

  it('keeps the requested behavior without matchMedia', () => {
    expect(typeof window).toBe('undefined')
    expect(motionSafeScrollBehavior()).toBe('smooth')

    vi.stubGlobal('window', {})
    expect(motionSafeScrollBehavior('smooth')).toBe('smooth')
    expect(motionSafeScrollBehavior('auto')).toBe('auto')
  })
})
