import { z } from 'zod'
import { PLUGIN_EVENT_NAMES } from '../contributions/plugin-event-contribution'
import { ALL_SURFACES, FRAMES_ONLY, spec } from './plugin-host-method-spec'
import { AGENT_STATUS_STATES } from '../../agent-status-types'
import {
  PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS,
  pluginBridgeNameSchema
} from './plugin-panel-bridge-protocol'

const pluginRequestParams = z.strictObject({
  name: pluginBridgeNameSchema,
  input: z.json().optional(),
  /** How long the worker may take; it sees an aborted `signal` past it. */
  timeoutMs: z.number().int().min(1).max(PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS).optional()
})
const pluginRequestResult = z.object({ output: z.json() })

export const PLUGIN_AGENT_LIST_LIMIT = 50
const agentsListParams = z.strictObject({}).optional()
const agentsListResult = z.object({
  agents: z
    .array(
      z.object({
        /** Its terminal, as `workspace.readContext` and `terminal.sendText` name it; null when
         *  Orca cannot tie the agent's pane to a terminal it lists. */
        terminalId: z.string().min(1).max(1024).nullable(),
        title: z.string().max(512).nullable(),
        /** Which agent runs there (`claude`, `codex`, ...), when Orca knows. */
        agent: z.string().max(128).nullable(),
        state: z.enum(AGENT_STATUS_STATES),
        /** When it entered `state`, in ms since the epoch. */
        stateStartedAt: z.number().finite()
      })
    )
    .max(PLUGIN_AGENT_LIST_LIMIT)
})

const eventsSubscribeParams = z.strictObject({ event: z.enum(PLUGIN_EVENT_NAMES) })
const eventsSubscribeResult = z.object({ ok: z.literal(true) })

/** Panels and their own worker; spread into PLUGIN_HOST_API. */
export const PLUGIN_PANEL_BRIDGE_API = {
  'plugin.request': spec({
    summary:
      "Asks the plugin's own worker to run the handler it registered with `orca.panels.handle(name)`, starting the worker if needed; resolves with what the handler returned. `unknown_method` when no handler has that name.",
    since: 2,
    scope: 'plugin-private',
    capability: null,
    mutation: false,
    surfaces: FRAMES_ONLY,
    params: pluginRequestParams,
    result: pluginRequestResult
  }),
  'agents.list': spec({
    summary:
      'The agents in the focused workspace: their terminal, title, agent kind and status. `agent.status.changed` reports each change after.',
    since: 2,
    scope: 'active-workspace',
    capability: 'agent:read',
    mutation: false,
    surfaces: ALL_SURFACES,
    params: agentsListParams,
    result: agentsListResult
  }),
  'events.subscribe': spec({
    summary:
      "Delivers a workspace or agent event to this panel as `orca.on(event)`; needs the event's read capability. The frame APIs call it for you.",
    since: 2,
    scope: 'plugin-private',
    capability: null,
    mutation: false,
    surfaces: FRAMES_ONLY,
    params: eventsSubscribeParams,
    result: eventsSubscribeResult
  })
}
