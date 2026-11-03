import { z } from 'zod'
import {
  LIST_ARRANGEMENT_LIMITS,
  listArrangementSchema,
  type ListArrangement
} from '../../workspace-lists/list-arrangement-schema'
import { compileListArrangement } from '../../workspace-lists/compile-list-arrangement'
import { pluginContentIdSchema } from './plugin-theme-artifact'

export const PLUGIN_WORKSPACE_LIST_MAX_BYTES = LIST_ARRANGEMENT_LIMITS.maxBytes

const pluginWorkspaceListRegistrationSchema = z.object({
  id: pluginContentIdSchema,
  pluginKey: z.string(),
  pluginName: z.string(),
  label: z.string(),
  description: z.string().optional(),
  revision: z.string(),
  arrangement: listArrangementSchema
})

export type PluginWorkspaceListRegistration = z.infer<typeof pluginWorkspaceListRegistrationSchema>

/** Parses an arrangement file; throws when Orca could not evaluate its rules. */
export function parsePluginWorkspaceListArtifact(raw: string): ListArrangement {
  const arrangement = listArrangementSchema.parse(JSON.parse(raw))
  compileListArrangement(arrangement)
  return arrangement
}

export function isPluginWorkspaceListRegistration(
  value: unknown
): value is PluginWorkspaceListRegistration {
  return pluginWorkspaceListRegistrationSchema.safeParse(value).success
}
