// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { BrowserGrabActionShortcutArgs } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { useHoldAltSeeThrough } from './use-hold-alt-see-through'

let forward: ((args: BrowserGrabActionShortcutArgs) => void) | null = null

beforeEach(() => {
  forward = null
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onGrabActionShortcut: (listener: (args: BrowserGrabActionShortcutArgs) => void) => {
          forward = listener
          return () => {
            forward = null
          }
        }
      }
    }
  })
})

describe('hold Alt to see through the palette', () => {
  it('releases when Alt went down in the app and came up in the page after the pick settled', () => {
    const { result } = renderHook(() => useHoldAltSeeThrough('page-1'))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }))
    })
    expect(result.current).toBe(true)
    expect(document.documentElement.hasAttribute('data-browser-annotate-see-through')).toBe(true)

    // The page has focus now; main always mirrors the release, pick or not.
    act(() => forward?.({ browserPageId: 'page-1', key: 'alt-up' }))

    expect(result.current).toBe(false)
    expect(document.documentElement.hasAttribute('data-browser-annotate-see-through')).toBe(false)
  })

  it("ignores another page's Alt release", () => {
    const { result } = renderHook(() => useHoldAltSeeThrough('page-1'))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }))
    })

    act(() => forward?.({ browserPageId: 'page-2', key: 'alt-up' }))

    expect(result.current).toBe(true)
  })

  it('releases when the window loses focus mid-hold', () => {
    const { result } = renderHook(() => useHoldAltSeeThrough(null))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }))
    })

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    expect(result.current).toBe(false)
  })
})
