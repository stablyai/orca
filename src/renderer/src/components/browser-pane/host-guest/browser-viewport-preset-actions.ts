import type {
  BrowserPage,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../shared/browser-viewport-presets'
import { useAppStore } from '@/store'

export const DEFAULT_MOBILE_VIEWPORT_PRESET_ID: BrowserViewportPresetId = 'mobile-m'

type BrowserViewportSelection = Pick<
  BrowserPage,
  'viewportPresetId' | 'lastMobileViewportPresetId' | 'lastNonMobileViewportPresetId'
>

function rememberedPreset(
  id: BrowserViewportPresetId | null | undefined,
  mobile: boolean
): BrowserViewportPresetId | null {
  const preset = getBrowserViewportPreset(id)
  return preset?.mobile === mobile ? preset.id : null
}

export function resolveBrowserViewportToggleTarget(
  page: BrowserViewportSelection
): BrowserViewportPresetId | null {
  const current = getBrowserViewportPreset(page.viewportPresetId)
  if (current?.mobile) {
    if (page.lastNonMobileViewportPresetId === null) {
      return null
    }
    return rememberedPreset(page.lastNonMobileViewportPresetId, false)
  }
  return (
    rememberedPreset(page.lastMobileViewportPresetId, true) ?? DEFAULT_MOBILE_VIEWPORT_PRESET_ID
  )
}

export function applyBrowserPageViewportPreset(
  browserPageId: string,
  presetId: BrowserViewportPresetId | null
): void {
  useAppStore.getState().setBrowserPageViewportPreset(browserPageId, presetId)
  const preset = getBrowserViewportPreset(presetId)
  const override = preset ? browserViewportPresetToOverride(preset) : null
  void window.api.browser.setViewportOverride({ browserPageId, override })
}
