import { describe, expect, it } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { resolveBrowserViewportToggleTarget } from './browser-viewport-preset-actions'

type Selection = Pick<
  BrowserPage,
  'viewportPresetId' | 'lastMobileViewportPresetId' | 'lastNonMobileViewportPresetId'
>

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    viewportPresetId: null,
    lastMobileViewportPresetId: null,
    lastNonMobileViewportPresetId: undefined,
    ...overrides
  }
}

describe('resolveBrowserViewportToggleTarget', () => {
  it('uses Mobile M from the responsive viewport and returns to the responsive viewport', () => {
    expect(resolveBrowserViewportToggleTarget(selection())).toBe('mobile-m')
    expect(
      resolveBrowserViewportToggleTarget(
        selection({ viewportPresetId: 'mobile-m', lastNonMobileViewportPresetId: null })
      )
    ).toBeNull()
  })

  it('switches in both directions using the most recently selected states', () => {
    expect(
      resolveBrowserViewportToggleTarget(
        selection({
          viewportPresetId: 'mobile-l',
          lastMobileViewportPresetId: 'mobile-l',
          lastNonMobileViewportPresetId: 'laptop-l'
        })
      )
    ).toBe('laptop-l')
    expect(
      resolveBrowserViewportToggleTarget(
        selection({
          viewportPresetId: 'laptop-l',
          lastMobileViewportPresetId: 'mobile-l',
          lastNonMobileViewportPresetId: 'laptop-l'
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
    expect(
      resolveBrowserViewportToggleTarget(
        selection({ viewportPresetId: 'mobile-m', lastNonMobileViewportPresetId: 'mobile-l' })
      )
    ).toBeNull()
  })
})
