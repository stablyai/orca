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

// Why: `method` is checked against PLUGIN_TASK_SOURCE_METHODS by the handler,
// not here — an unknown value must produce a `validation` envelope in the
// reply, not a schema-parse rejection at the transport boundary.
export const PluginInvokeTaskSourceParams = z.object({
  pluginKey: z.string().min(1),
  sourceId: z.string().min(1),
  method: z.string().min(1).max(64),
  params: z.unknown().optional()
})

export const PluginsPanelActionParams = z.unknown()
