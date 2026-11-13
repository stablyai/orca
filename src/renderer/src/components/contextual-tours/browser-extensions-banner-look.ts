import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import {
  activeBrowserExtensionsBanner,
  browserExtensionsBannerStyle,
  type BrowserExtensionsBanner
} from '../../../../shared/browser/extensions/browser-extensions-banner'
import type {
  ContextualTourId,
  ContextualTourStepActionKind
} from '../../../../shared/contextual-tours'
import { trackBrowserExtensionsBannerAction } from '@/diagnostics/telemetry/browser-extensions-telemetry'
import type { ActiveTourRenderState } from './ContextualTourOverlaySurface'

/** The step itself carries the default look; an install's saved banner may restyle it. */
export function withBrowserExtensionsBannerLook(
  state: ActiveTourRenderState,
  banner: BrowserExtensionsBanner | undefined
): ActiveTourRenderState {
  if (!banner || banner === 'none') {
    return state
  }
  const { coloredIcons, copy } = browserExtensionsBannerStyle(banner)
  return {
    ...state,
    title:
      copy === 'everyday'
        ? translate(
            'auto.components.contextual.tours.contextual.tour.step.copy.browser.extensions.intro.everydayTitle',
            'Your everyday browser tools, in Orca'
          )
        : state.title,
    control: { kind: 'browser-extension-icons', colored: coloredIcons }
  }
}

/**
 * While the extensions banner is the active tour: its saved look, and a reporter for how someone
 * answered it. Other tours pass through unchanged and report nothing.
 */
export function useBrowserExtensionsBanner(
  activeTourId: ContextualTourId | null,
  renderState: ActiveTourRenderState | null
): {
  renderState: ActiveTourRenderState | null
  trackStep: (kind: ContextualTourStepActionKind | 'close') => void
} {
  const banner = useAppStore((s) =>
    s.activeContextualTourId === 'browser-extensions'
      ? activeBrowserExtensionsBanner(s.settings?.telemetry?.browserExtensionsBanner)
      : undefined
  )
  const isBanner = activeTourId === 'browser-extensions'
  return {
    renderState:
      isBanner && renderState ? withBrowserExtensionsBannerLook(renderState, banner) : null,
    trackStep: (kind) => {
      if (isBanner) {
        trackBrowserExtensionsBannerStep(kind)
      }
    }
  }
}

function trackBrowserExtensionsBannerStep(kind: ContextualTourStepActionKind | 'close'): void {
  if (kind === 'open-chrome-web-store') {
    trackBrowserExtensionsBannerAction('open_web_store')
  } else if (kind === 'complete') {
    trackBrowserExtensionsBannerAction('got_it')
  } else if (kind === 'close') {
    trackBrowserExtensionsBannerAction('close')
  }
}
