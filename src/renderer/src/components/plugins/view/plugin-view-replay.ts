import { parsePluginDeclarativeTree } from '../../../../../shared/plugins/declarative/plugin-declarative-tree'
import type {
  PluginViewReply,
  PluginViewRequest
} from '../../../../../shared/plugins/view/plugin-view-protocol'
import { useAppStore } from '@/store'
import { usePluginShotReplayStore } from '@/store/plugin-shot-replay'
import { usePluginViewCaptureStore } from '@/store/plugin-view-capture'
import {
  clampRightSidebarPanelWidth,
  RIGHT_SIDEBAR_SIDE_ACTIVITY_BAR_WIDTH
} from '../../right-sidebar/right-sidebar-width'
import { nextPaintedFrames, waitForColorScheme } from './plugin-view-panel-settle'

let replays = 0

const NOT_DRAWN = 'replay_not_drawn'

/** For the CLI's error output, like the other view replies; never shown in Orca's UI. */
function fail(requestId: string, code: string, message: string): PluginViewReply {
  return { requestId, ok: false, code, message }
}

export const PLUGIN_SHOT_REPLAY_SELECTOR = '[data-plugin-shot-replay]'

/** The preview's rect in CSS pixels, or null until it is laid out. */
export function measurePluginShotReplay(): {
  x: number
  y: number
  width: number
  height: number
} | null {
  const surface = document.querySelector(PLUGIN_SHOT_REPLAY_SELECTOR)
  if (!surface) {
    return null
  }
  const { x, y, width, height } = surface.getBoundingClientRect()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** What the right sidebar draws its panel at now, so a replay matches the person's own width. */
function currentPanelWidth(): number {
  const state = useAppStore.getState()
  const extra = state.activityBarPosition === 'side' ? RIGHT_SIDEBAR_SIDE_ACTIVITY_BAR_WIDTH : 0
  return clampRightSidebarPanelWidth(state.rightSidebarWidth, window.innerWidth, extra)
}

async function waitForSurface(timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (!measurePluginShotReplay()) {
    if (performance.now() >= deadline) {
      return false
    }
    // The surface is lazy, so its chunk may still be loading.
    await nextPaintedFrames()
  }
  return true
}

/**
 * Draws the tree in the detached preview and reports its rect. It never opens, switches or
 * touches a plugin panel; `end-capture` unmounts it.
 */
export async function replayPluginPanel(
  request: Extract<PluginViewRequest, { kind: 'replay-panel' }>
): Promise<PluginViewReply> {
  const { requestId, replay } = request
  const parsed = parsePluginDeclarativeTree(replay.tree)
  if (!parsed.ok) {
    return fail(requestId, 'invalid_tree', parsed.error)
  }
  const wantDark = replay.colorScheme === undefined ? null : replay.colorScheme === 'dark'
  // panelWidth null: the person's right sidebar keeps its own width.
  usePluginViewCaptureStore.getState().begin({ panelWidth: null, dark: wantDark })
  const width = Math.min(replay.width ?? currentPanelWidth(), window.innerWidth)
  replays += 1
  usePluginShotReplayStore.getState().show({ tree: parsed.tree, width, id: replays })
  if (!(await waitForSurface(replay.timeoutMs))) {
    return fail(requestId, NOT_DRAWN, 'Orca did not draw the scenario preview in time.')
  }
  await waitForColorScheme(wantDark)
  const rect = measurePluginShotReplay()
  if (!rect) {
    return fail(requestId, NOT_DRAWN, 'The preview has no area.')
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

/** Unmounts the preview; part of `end-capture`. */
export function endPluginShotReplay(): void {
  usePluginShotReplayStore.getState().clear()
}
