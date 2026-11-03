import type {
  PluginShotAct,
  PluginShotActResult
} from '../../../../../shared/plugins/view/plugin-shot-acts'
import {
  pluginDeclarativeActExpansion,
  pluginDeclarativeActTarget
} from '../declarative/plugin-declarative-act-targets'
import {
  pluginPanelActDriver,
  type PluginPanelActDriver
} from '../../right-sidebar/plugin-panel-act-driver'
import { runPluginPanelActs } from './plugin-view-acts'
import {
  PLUGIN_PANEL_ACT_FIRST_DRAW_MS,
  PLUGIN_PANEL_SHOT_FIRST_QUIET_MS,
  settlePluginPanel
} from './plugin-view-panel-settle'

// The panel `--act` changed, until `end-capture` puts its atoms back.
let acted: PluginPanelActDriver | null = null

/**
 * A drawn components panel before its capture: waits for its worker's answers, then runs `acts`
 * (remembering the panel's atoms first). Not ok: acts for a panel that is not drawn components.
 */
export async function settleAndActOnPanel(
  tabKey: string,
  ui: 'components' | 'html' | undefined,
  acts: readonly PluginShotAct[] | undefined
): Promise<
  { ok: true; pendingRequests?: number; actions?: PluginShotActResult[] } | { ok: false }
> {
  const driver = ui === 'components' ? pluginPanelActDriver(tabKey) : null
  if (!driver) {
    return acts ? { ok: false } : { ok: true }
  }
  await settlePluginPanel(driver, PLUGIN_PANEL_SHOT_FIRST_QUIET_MS)
  if (!acts) {
    return { ok: true, pendingRequests: driver.pending() }
  }
  acted = driver
  driver.snapshot()
  const actions = await runPluginPanelActs(acts, {
    driver,
    targetOf: pluginDeclarativeActTarget,
    expansionOf: pluginDeclarativeActExpansion,
    settle: () => settlePluginPanel(driver, PLUGIN_PANEL_ACT_FIRST_DRAW_MS)
  })
  return { ok: true, pendingRequests: driver.pending(), actions }
}

/** After the capture: the acted panel's atoms back, drawn; undefined when nothing acted. */
export async function restoreActedPanel(): Promise<boolean | undefined> {
  const driver = acted
  acted = null
  if (!driver) {
    return undefined
  }
  const restored = driver.restore()
  if (restored) {
    await settlePluginPanel(driver, PLUGIN_PANEL_ACT_FIRST_DRAW_MS)
  }
  return restored
}
