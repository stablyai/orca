import type {
  PluginChromeRegion,
  PluginViewColorScheme,
  PluginViewReply
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import { nextPaintedFrames, waitForColorScheme } from './plugin-view-panel-settle'

type Rect = { x: number; y: number; width: number; height: number }

function measureChrome(region: PluginChromeRegion): Rect | null {
  if (region === 'window') {
    const { clientWidth: width, clientHeight: height } = document.documentElement
    return width > 0 && height > 0 ? { x: 0, y: 0, width, height } : null
  }
  const bar = document.querySelector('[data-orca-status-bar]')
  if (!bar) {
    return null
  }
  const { x, y, width, height } = bar.getBoundingClientRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** Paints Orca in the asked theme, then measures the status bar or the whole window. */
export async function captureChrome(
  requestId: string,
  region: PluginChromeRegion,
  colorScheme: PluginViewColorScheme | undefined
): Promise<PluginViewReply> {
  const wantDark = colorScheme === undefined ? null : colorScheme === 'dark'
  usePluginViewCaptureStore.getState().begin({ panelWidth: null, dark: wantDark })
  await waitForColorScheme(wantDark)
  await nextPaintedFrames()
  const rect = measureChrome(region)
  if (!rect) {
    return {
      requestId,
      ok: false,
      code: 'chrome_hidden',
      message:
        region === 'status-bar'
          ? "Orca's status bar is hidden; turn on Appearance > Show Status Bar, then shoot again."
          : "Orca's window has no area to capture."
    }
  }
  const dark = document.documentElement.classList.contains('dark')
  return {
    requestId,
    ok: true,
    panel: {
      rect,
      ui: 'components',
      guestUrl: null,
      issue: null,
      colorScheme: dark ? 'dark' : 'light',
      themeApplied: wantDark !== null && dark === wantDark,
      settled: true
    }
  }
}
