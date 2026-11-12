import { z } from 'zod'
import {
  pluginTerminalIdSchema,
  pluginWorkspaceIdSchema
} from './plugin-host-api-workspace-methods'
import {
  PLUGIN_WORKSPACE_LABEL_MAX_LENGTH,
  PLUGIN_WORKSPACE_TERMINAL_LIMIT
} from './plugin-host-api-workspace-context'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Terminals of any workspace, by the ids `terminal.read` and `terminal.sendText` take. Each runs
 *  the runtime method `orca terminal list|focus|close` runs, on the host that owns the terminal. */

const terminalListParams = z.strictObject({ workspaceId: pluginWorkspaceIdSchema })
const terminalListResult = z.object({
  terminals: z
    .array(
      z.object({
        id: pluginTerminalIdSchema,
        /** The pane's name, or its terminal title; absent when it has neither. */
        title: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH).optional()
      })
    )
    .max(PLUGIN_WORKSPACE_TERMINAL_LIMIT),
  /** The workspace has more terminals than the list holds. */
  truncated: z.boolean()
})

const terminalTargetParams = z.strictObject({ terminalId: pluginTerminalIdSchema })
const terminalFocusResult = z.object({ focused: z.literal(true) })
const terminalCloseResult = z.object({
  closed: z.literal(true),
  /** Nothing runs in the terminal any more. False when Orca could not confirm its process
   *  stopped: it may still run, as on an unreachable SSH host, where Orca stops it on reconnect. */
  processExited: z.boolean()
})

export const PLUGIN_TERMINAL_ACTIONS_API = {
  'terminal.list': spec({
    summary: `Lists a workspace's terminals, at most ${PLUGIN_WORKSPACE_TERMINAL_LIMIT}; \`workspace.readContext\` lists the focused one's.`,
    since: 7,
    scope: 'any-workspace',
    capability: 'workspace:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: terminalListParams,
    result: terminalListResult
  }),
  'terminal.focus': spec({
    summary:
      "Shows a terminal's workspace and focuses its pane, as clicking it does; desktop app only.",
    since: 7,
    scope: 'explicit-terminal',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: terminalTargetParams,
    result: terminalFocusResult
  }),
  'terminal.close': spec({
    summary:
      'Closes a terminal, stopping what runs in it (local or SSH), as `orca terminal close` does; closing its last pane closes the tab.',
    since: 7,
    scope: 'explicit-terminal',
    capability: 'terminal:send',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: terminalTargetParams,
    result: terminalCloseResult
  })
}
