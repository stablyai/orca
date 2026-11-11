import { useAppStore } from '@/store'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../shared/browser-viewport-presets'
import { setBrowserPageAgentViewportSize } from '../host-guest/browser-page-viewport'

/** The user's pick replaces an agent's viewport, in the box and in the page; null is Default. */
export function applyBrowserViewportPreset(
  browserPageId: string,
  nextId: BrowserViewportPresetId | null
): void {
  setBrowserPageAgentViewportSize(browserPageId, null)
  useAppStore.getState().setBrowserPageViewportPreset(browserPageId, nextId)
  const preset = getBrowserViewportPreset(nextId)
  const override = preset ? browserViewportPresetToOverride(preset) : null
  void window.api.browser.setViewportOverride({ browserPageId, override })
}
