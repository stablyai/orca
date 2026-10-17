import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/plugin-manifest'
import { PLUGIN_PANEL_SURFACES } from '../plugins/plugin-panel-bridge'

export const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

export const PluginReadPanelEntryParams = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1),
  surface: z.enum(PLUGIN_PANEL_SURFACES).optional()
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const PluginsPanelActionParams = z.unknown()
