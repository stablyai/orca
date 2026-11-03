import { PLUGIN_CARDS_API } from './plugin-host-api-cards'
import { PLUGIN_STATUS_BAR_API } from './plugin-host-api-status-bar'
import { PLUGIN_WORKSPACE_ACTIONS_API } from './plugin-host-api-workspace-methods'

/** Worker-only methods that act on Orca: its status bar, workspaces, terminals and agents.
 *  Spread into PLUGIN_HOST_API. */
export const PLUGIN_WORKER_ACTIONS_API = {
  ...PLUGIN_STATUS_BAR_API,
  ...PLUGIN_CARDS_API,
  ...PLUGIN_WORKSPACE_ACTIONS_API
}
