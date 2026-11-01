import {
  isPluginPanelDrawSettled,
  pluginPanelDrawStatus,
  subscribePluginPanelDraw,
  type PluginPanelDrawStatus
} from '../../right-sidebar/plugin-panel-draw-status'

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
