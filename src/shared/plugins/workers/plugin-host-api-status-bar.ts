import { z } from 'zod'
import { pluginIdSchema } from '../manifest/plugin-manifest-fields'
import { pluginStatusBarItemPatchSchema } from '../contributions/plugin-status-bar-item-contribution'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

const statusBarUpdateParams = z.strictObject({
  id: pluginIdSchema,
  ...pluginStatusBarItemPatchSchema.shape
})
const statusBarUpdateResult = z.object({ ok: z.literal(true) })

/** The plugin's own status bar items; spread into PLUGIN_HOST_API. */
export const PLUGIN_STATUS_BAR_API = {
  'statusBar.update': spec({
    summary:
      "Changes one of the plugin's `contributes.statusBarItems` (named by `id`): fields given replace their current value, `visible: false` hides it. Desktop app only; lasts until Orca restarts, and is hidden while the plugin is disabled.",
    since: 2,
    scope: 'plugin-private',
    capability: null,
    // Why not audited: it only redraws the plugin's own item, possibly many times a minute.
    mutation: false,
    surfaces: WORKER_ONLY,
    params: statusBarUpdateParams,
    result: statusBarUpdateResult
  })
}
