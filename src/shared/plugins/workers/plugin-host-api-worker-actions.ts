import { PLUGIN_STATUS_BAR_API } from './plugin-host-api-status-bar'
import { PLUGIN_WORKSPACE_ACTIONS_API } from './plugin-host-api-workspace-methods'
import { PLUGIN_APPEARANCE_API } from './plugin-host-api-appearance'
import { PLUGIN_TERMINAL_ACTIONS_API } from './plugin-host-api-terminal-methods'
import { PLUGIN_WORKSPACE_CREATE_API } from './plugin-host-api-workspace-create'
import { PLUGIN_AUTOMATION_API } from './plugin-host-api-automation-methods'
import { PLUGIN_AGENT_HISTORY_API } from './plugin-host-api-agent-history'
import { PLUGIN_PROJECT_VISIBILITY_API } from './plugin-host-api-project-visibility'

/** Worker-only methods that act on Orca: its status bar, projects, workspaces, terminals, agents,
 *  agent session history and automations. Spread into PLUGIN_HOST_API. */
export const PLUGIN_WORKER_ACTIONS_API = {
  ...PLUGIN_STATUS_BAR_API,
  ...PLUGIN_APPEARANCE_API,
  ...PLUGIN_WORKSPACE_ACTIONS_API,
  ...PLUGIN_PROJECT_VISIBILITY_API,
  ...PLUGIN_TERMINAL_ACTIONS_API,
  ...PLUGIN_WORKSPACE_CREATE_API,
  ...PLUGIN_AUTOMATION_API,
  ...PLUGIN_AGENT_HISTORY_API
}
