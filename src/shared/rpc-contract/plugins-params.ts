import { z } from 'zod'
import { isQualifiedPluginKey } from '../plugins/plugin-manifest'

export const PluginSetEnabledParams = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey, 'invalid qualified plugin key'),
  enabled: z.boolean()
})

export const PluginReadPanelEntryParams = z.object({
  pluginKey: z.string().min(1),
  panelId: z.string().min(1)
})

export const PluginInvokeCommandParams = z.object({
  pluginKey: z.string().min(1),
  commandId: z.string().min(1),
  args: z.unknown().optional()
})

export const PluginsPanelActionParams = z.unknown()
