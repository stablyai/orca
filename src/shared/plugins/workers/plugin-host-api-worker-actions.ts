import { PLUGIN_STATUS_BAR_API } from './plugin-host-api-status-bar'
import { PLUGIN_WORKSPACE_ACTIONS_API } from './plugin-host-api-workspace-methods'
import { PLUGIN_APPEARANCE_API } from './plugin-host-api-appearance'
import { PLUGIN_TERMINAL_ACTIONS_API } from './plugin-host-api-terminal-methods'
import { PLUGIN_WORKSPACE_CREATE_API } from './plugin-host-api-workspace-create'
import { PLUGIN_AUTOMATION_API } from './plugin-host-api-automation-methods'

/** Worker-only methods that act on Orca: its status bar, workspaces, terminals, agents and
 *  automations. Spread into PLUGIN_HOST_API. */
export const PLUGIN_WORKER_ACTIONS_API = {
  ...PLUGIN_STATUS_BAR_API,
  ...PLUGIN_APPEARANCE_API,
  ...PLUGIN_WORKSPACE_ACTIONS_API,
  ...PLUGIN_TERMINAL_ACTIONS_API,
  ...PLUGIN_WORKSPACE_CREATE_API,
  ...PLUGIN_AUTOMATION_API
}
