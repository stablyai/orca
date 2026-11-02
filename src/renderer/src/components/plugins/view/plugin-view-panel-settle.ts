import {
  isPluginPanelDrawSettled,
  pluginPanelDrawStatus,
  subscribePluginPanelDraw,
  type PluginPanelDrawStatus
} from '../../right-sidebar/plugin-panel-draw-status'
import type { PluginPanelActDriver } from '../../right-sidebar/plugin-panel-act-driver'

// Why a fallback: a hidden window may not tick animation frames, and a capture must not hang.
const FRAME_FALLBACK_MS = 100

/** Resolves on the panel's draw for `revision`, or at the deadline with whatever it shows. */
export function waitForPluginPanelDraw(
  tabKey: string,
  revision: string | null,
  timeoutMs: number
): Promise<{ settled: boolean; value: PluginPanelDrawStatus | null }> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    const finish = (settled: boolean): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve({ settled, value: pluginPanelDrawStatus(tabKey) })
    }
    if (isPluginPanelDrawSettled(pluginPanelDrawStatus(tabKey), revision)) {
      finish(true)
      return
    }
    unsubscribe = subscribePluginPanelDraw(() => {
      if (isPluginPanelDrawSettled(pluginPanelDrawStatus(tabKey), revision)) {
        finish(true)
      }
    })
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, FRAME_FALLBACK_MS)
    requestAnimationFrame(() => {
      clearTimeout(fallback)
      resolve()
    })
  })
}

/** Two frames: React commits what the last state change asked for, then the browser paints it. */
export async function nextPaintedFrames(): Promise<void> {
  await nextFrame()
  await nextFrame()
}

/** The panel's rect in CSS pixels, or null when it is not laid out. */
export function measurePluginPanelSurface(
  tabKey: string
): { x: number; y: number; width: number; height: number } | null {
  const surface = document.querySelector(`[data-plugin-panel-surface="${CSS.escape(tabKey)}"]`)
  if (!surface) {
    return null
  }
  const { x, y, width, height } = surface.getBoundingClientRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** An html panel's guest `<webview>` rect in CSS pixels, so main can capture the guest itself. */
export function measurePluginPanelGuest(
  tabKey: string
): { x: number; y: number; width: number; height: number } | null {
  const surface = document.querySelector(`[data-plugin-panel-surface="${CSS.escape(tabKey)}"]`)
  const guest = surface?.querySelector('webview')
  if (!guest) {
    return null
  }
  const { x, y, width, height } = guest.getBoundingClientRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

// Why these: a handler that awaits a host call draws well within 1s, a burst of renders ends within
// a quiet 150ms, a cold panel asks its worker within 300ms of its first tree, and 3s caps a panel
// that keeps re-rendering or a request that never answers.
export const PLUGIN_PANEL_ACT_FIRST_DRAW_MS = 1_000
export const PLUGIN_PANEL_SHOT_FIRST_QUIET_MS = 300
const QUIET_MS = 150
export const PLUGIN_PANEL_MAX_SETTLE_MS = 3_000

/**
 * Waits until the panel has no host call in flight (its worker answered) and no new tree for a
 * quiet spell (`firstQuietMs` at first), then for what it drew to paint; at most 3s.
 */
export async function settlePluginPanel(
  driver: Pick<PluginPanelActDriver, 'pending' | 'onChange'>,
  firstQuietMs: number
): Promise<void> {
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = (): void => {}
    const finish = (): void => {
      clearTimeout(quiet)
      clearTimeout(cap)
      unsubscribe()
      resolve()
    }
    const arm = (ms: number): void => {
      clearTimeout(quiet)
      quiet = driver.pending() > 0 ? undefined : setTimeout(finish, ms)
    }
    const cap = setTimeout(finish, PLUGIN_PANEL_MAX_SETTLE_MS)
    arm(firstQuietMs)
    unsubscribe = driver.onChange(() => arm(QUIET_MS))
  })
  await nextPaintedFrames()
}

// Why a cap: a theme Orca cannot apply must not hold the shot forever.
const COLOR_SCHEME_MAX_FRAMES = 60

/** Frames until the document shows the asked color scheme, so the capture is of that repaint. */
export async function waitForColorScheme(wantDark: boolean | null): Promise<void> {
  for (let frame = 0; wantDark !== null && frame < COLOR_SCHEME_MAX_FRAMES; frame += 1) {
    if (document.documentElement.classList.contains('dark') === wantDark) {
      break
    }
    await nextFrame()
  }
  await nextPaintedFrames()
}
