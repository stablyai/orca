import {
  AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY,
  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
} from './agent-session/structured-agent-session-surface-capabilities'
import {
  AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from './agent-session/agent-session-runtime-capabilities'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from './agent-session/requests/agent-session-current-requests-capability'
import {
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY
} from './protocol-version'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY,
  AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY
} from './agent-launch/contracts/agent-launch-runtime-capability'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from './agent-session/options/agent-session-optional-model-capability'
import { remoteRuntimeClientCapabilities } from './remote-runtime/remote-runtime-client-capabilities'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from './agent-session/agent-session-create-capabilities'
import { COMPRESSED_FRAMES_CLIENT_CAPABILITY } from './remote-runtime/e2ee/paired-e2ee-compressed-frame'

export const MOBILE_RUNTIME_CLIENT_CAPABILITIES = remoteRuntimeClientCapabilities([
  AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY,
  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  // Render every registered host agent so new agents remain usable without a phone release.
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  // Render Pi dialogs through existing approval/question cards.
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  // The model picker reads an options report with no model (OMP, or a chat at rest) as unknown.
  AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  // Opts into the typed turn record; without it the host sends the legacy status carrier.
  AGENT_SESSION_TURN_ITEM_CAPABILITY,
  // Advertise both structured and terminal launch support so the host may choose either outcome.
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  // Reads a listed launch tab with no terminal yet as not started, so the host may show it early.
  AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY,
  // Reads `agent_launch_tab_closed` (a user closed its tab, which stopped it) as a definite answer.
  AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY,
  // Native chat offers no Stop for a turn the host restored but could not confirm.
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY,
  // Every socket this list is sent on reads frames through MobileE2EEV2PhysicalChannel, which inflates them.
  COMPRESSED_FRAMES_CLIENT_CAPABILITY
])
