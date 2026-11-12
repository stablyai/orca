import { z } from 'zod'
import { pluginWorkspaceIdSchema } from './plugin-host-api-workspace-methods'

export const PLUGIN_WORKSPACE_TERMINAL_LIMIT = 50
export const PLUGIN_WORKSPACE_LABEL_MAX_LENGTH = 512
export const PLUGIN_TERMINAL_ID_MAX_LENGTH = 1024

/** What `workspace.readContext` answers and `workspace.changed` carries. */
export const pluginWorkspaceContextSchema = z
  .object({
    /** The id `workspace.list` gives this workspace, which every workspace method takes. A remote
     *  workspace Orca knows only from stored rows has its raw id. Absent before host API 1.7; a
     *  panel checks for the field, since its `api.minor` counts only the methods it is offered. */
    workspaceId: pluginWorkspaceIdSchema.optional(),
    branch: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    displayName: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH),
    /** Terminals of the focused workspace, so callers can address a specific
     *  terminal id — the API has no "active terminal" write target. */
    terminals: z
      .array(
        z
          .object({
            id: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH),
            /** The pane's name, or its terminal title; absent when it has neither. */
            title: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH).optional()
          })
          .strict()
      )
      .max(PLUGIN_WORKSPACE_TERMINAL_LIMIT)
  })
  .strict()
  .nullable()
