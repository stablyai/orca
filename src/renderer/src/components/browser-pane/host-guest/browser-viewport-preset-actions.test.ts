import { describe, expect, it } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { resolveBrowserViewportToggleTarget } from './browser-viewport-preset-actions'

type Selection = Pick<
  BrowserPage,
  'viewportPresetId' | 'lastMobileViewportPresetId' | 'lastDesktopViewportPresetId'
>

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    viewportPresetId: null,
    lastMobileViewportPresetId: null,
    lastDesktopViewportPresetId: null,
    ...overrides
  }
}

describe('resolveBrowserViewportToggleTarget', () => {
  it('uses Mobile M from the responsive viewport and Desktop from a mobile viewport', () => {
    expect(resolveBrowserViewportToggleTarget(selection())).toBe('mobile-m')
    expect(resolveBrowserViewportToggleTarget(selection({ viewportPresetId: 'mobile-m' }))).toBe(
      'desktop'
    )
  })

  it('switches in both directions using the most recently selected presets', () => {
    expect(
      resolveBrowserViewportToggleTarget(
        selection({
          viewportPresetId: 'mobile-l',
          lastMobileViewportPresetId: 'mobile-l',
          lastDesktopViewportPresetId: 'laptop-l'
        })
      )
    ).toBe('laptop-l')
    expect(
      resolveBrowserViewportToggleTarget(
        selection({
          viewportPresetId: 'laptop-l',
          lastMobileViewportPresetId: 'mobile-l',
          lastDesktopViewportPresetId: 'laptop-l'
        })
      )
    ).toBe('mobile-l')
  })

  it('ignores a remembered preset from the wrong viewport mode', () => {
    expect(
      resolveBrowserViewportToggleTarget(
        selection({ viewportPresetId: 'desktop', lastMobileViewportPresetId: 'laptop' })
      )
    ).toBe('mobile-m')
  })
})
