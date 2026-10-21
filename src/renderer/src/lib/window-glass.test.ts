// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWindowGlassAvailable, observeDocumentWindowGlass } from './window-glass'

describe('document window glass', () => {
  const queries = new Map<
    string,
    {
      matches: boolean
      addEventListener: ReturnType<typeof vi.fn>
      removeEventListener: ReturnType<typeof vi.fn>
    }
  >()
  const nativeChanged = vi.fn<(callback: (available: boolean) => void) => () => void>()
  const unsubscribe = vi.fn()
  const bridge = { getWindowGlassAvailable: () => true, onWindowGlassChanged: nativeChanged }
  let cleanup: (() => void) | undefined

  beforeEach(() => {
    queries.clear()
    nativeChanged.mockReset().mockReturnValue(unsubscribe)
    unsubscribe.mockClear()
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        const state = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
        queries.set(query, state)
        return state
      })
    )
  })

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.unstubAllGlobals()
  })

  it('keeps standard and unsupported renderers solid without subscribing', () => {
    cleanup = observeDocumentWindowGlass({ enabled: false }, bridge)
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
    expect(nativeChanged).not.toHaveBeenCalled()
    cleanup()
    cleanup = observeDocumentWindowGlass({ enabled: true }, undefined)
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
  })

  it('follows effective native availability and clears stale styles on cleanup', () => {
    cleanup = observeDocumentWindowGlass({ enabled: true, style: 'liquid', opacity: 0.72 }, bridge)
    expect(document.documentElement.dataset.windowGlass).toBe('liquid')
    expect(document.documentElement.style.getPropertyValue('--window-glass-opacity')).toBe('0.72')
    const notify = nativeChanged.mock.calls[0][0]
    notify(false)
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
    notify(true)
    expect(document.documentElement.dataset.windowGlass).toBe('liquid')
    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--window-glass-opacity')).toBe('')
    for (const query of queries.values()) {
      expect(query.removeEventListener).toHaveBeenCalledWith(
        'change',
        query.addEventListener.mock.calls[0][1]
      )
    }
    cleanup = undefined
  })

  it.each([
    '(prefers-reduced-transparency: reduce)',
    '(forced-colors: active)',
    '(prefers-contrast: more)'
  ])('responds live to %s', (name) => {
    cleanup = observeDocumentWindowGlass({ enabled: true }, bridge)
    const query = queries.get(name)!
    query.matches = true
    query.addEventListener.mock.calls[0][1]()
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
    query.matches = false
    query.addEventListener.mock.calls[0][1]()
    expect(document.documentElement.dataset.windowGlass).toBe('frosted')
  })

  it.each([
    [Number.NaN, '0.9'],
    [Number.POSITIVE_INFINITY, '0.9'],
    [-1, '0'],
    [2, '1']
  ])('normalizes invalid opacity %s to %s', (opacity, expected) => {
    cleanup = observeDocumentWindowGlass({ enabled: true, opacity }, bridge)
    expect(document.documentElement.style.getPropertyValue('--window-glass-opacity')).toBe(expected)
  })

  it('does not infer native support when the bridge has no capability', () => {
    cleanup = observeDocumentWindowGlass({ enabled: true }, {})
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
  })

  it('starts solid when reduced transparency is already requested', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-transparency: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
    cleanup = observeDocumentWindowGlass({ enabled: true }, bridge)
    expect(document.documentElement.dataset.windowGlass).toBeUndefined()
    expect(isWindowGlassAvailable(true)).toBe(false)
    expect(isWindowGlassAvailable(false)).toBe(false)
  })
})
