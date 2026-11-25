import { z } from 'zod'
import {
  pluginDeclarativePersistPayloadSchema,
  type PluginDeclarativeStoredValue
} from './plugin-declarative-messages'

const sessionTokenSchema = z.string().min(1).max(256)
const workspaceSchema = z.string().min(1).max(4096).nullable()

/** Renderer → main: read or write a components panel's persisted atoms (`plugins:panelState`). */
export const pluginPanelStateRequestSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('read'), sessionToken: sessionTokenSchema, workspace: workspaceSchema })
    .strict(),
  z
    .object({
      op: z.literal('write'),
      sessionToken: sessionTokenSchema,
      workspace: workspaceSchema,
      entries: pluginDeclarativePersistPayloadSchema.shape.entries
    })
    .strict()
])
export type PluginPanelStateRequest = z.input<typeof pluginPanelStateRequestSchema>

export type PluginPanelStateSnapshot = {
  plugin: Record<string, PluginDeclarativeStoredValue>
  workspace: Record<string, PluginDeclarativeStoredValue>
}
export type PluginPanelStateResult =
  | { ok: true; state?: PluginPanelStateSnapshot }
  | { ok: false; error: string }
