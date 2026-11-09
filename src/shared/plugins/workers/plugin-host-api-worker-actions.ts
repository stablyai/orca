import { PLUGIN_STATUS_BAR_API } from './plugin-host-api-status-bar'
import { PLUGIN_WORKSPACE_ACTIONS_API } from './plugin-host-api-workspace-methods'
import { PLUGIN_APPEARANCE_API } from './plugin-host-api-appearance'

/** Worker-only methods that act on Orca: its status bar, workspaces, terminals and agents.
 *  Spread into PLUGIN_HOST_API. */
export const PLUGIN_WORKER_ACTIONS_API = {
  ...PLUGIN_STATUS_BAR_API,
  ...PLUGIN_APPEARANCE_API,
  ...PLUGIN_WORKSPACE_ACTIONS_API
}
