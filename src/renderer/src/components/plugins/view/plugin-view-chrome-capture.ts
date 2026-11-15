import type {
  PluginChromeRegion,
  PluginViewReply,
  PluginViewRequest
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import { usePluginViewCaptureStore } from '@/store/plugins/capture/plugin-view-capture'
import { nextPaintedFrames, waitForColorScheme } from './plugin-view-panel-settle'

type Rect = { x: number; y: number; width: number; height: number }

// Why these selectors: each names the root of what a theme colors there; the largest visible
// match wins, so split panes crop to the main one.
const REGION_SELECTORS: Record<Exclude<PluginChromeRegion, 'window'>, string> = {
  'status-bar': '[data-orca-status-bar]',
  sidebar: '[data-theme-region="sidebar"]',
  tabs: '[data-theme-region="tabs"]',
  editor: '.monaco-editor',
  terminal: '.xterm',
  chat: '[data-native-chat-root]'
}

function measureChrome(region: PluginChromeRegion): Rect | null {
  if (region === 'window') {
    const { clientWidth: width, clientHeight: height } = document.documentElement
    return width > 0 && height > 0 ? { x: 0, y: 0, width, height } : null
  }
  const { clientWidth, clientHeight } = document.documentElement
  let best: Rect | null = null
  for (const element of document.querySelectorAll(REGION_SELECTORS[region])) {
    // Why: inactive terminals and editors stay mounted, hidden or off screen.
    if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) {
      continue
    }
    const box = element.getBoundingClientRect()
    const x = Math.max(0, box.left)
    const y = Math.max(0, box.top)
    const width = Math.min(clientWidth, box.right) - x
    const height = Math.min(clientHeight, box.bottom) - y
    if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) {
      best = { x, y, width, height }
    }
  }
  return best
}

/** Paints Orca in the asked theme, then measures the status bar or the whole window. */
export async function captureChrome(
  request: Extract<PluginViewRequest, { kind: 'capture-chrome' }>
): Promise<PluginViewReply> {
  const { requestId, region, colorScheme, captureId } = request
  const wantDark = colorScheme === undefined ? null : colorScheme === 'dark'
  usePluginViewCaptureStore.getState().begin({
    panelWidth: null,
    dark: wantDark,
    ...(captureId === undefined ? {} : { owner: captureId })
  })
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
          : region === 'window'
            ? "Orca's window has no area to capture."
            : `Orca shows no ${region} right now; open one in the active workspace, then shoot again.`
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
