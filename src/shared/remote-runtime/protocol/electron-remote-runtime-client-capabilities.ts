import { GIT_REVERT_CONFLICT_CLIENT_CAPABILITY } from '../../git/commands/git-commit-action'
import { GIT_GRAPH_TAB_CAPABILITY } from '../../source-control/runtime/git-graph-capabilities'
import { STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES } from '../../agent-session/capabilities/structured-agent-session-renderer-client-capabilities'
import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from '../../terminal/images/terminal-image-viewer-capability'
import { TERMINAL_HOST_PANE_RESPAWN_CLIENT_CAPABILITY } from '../../terminal/pty/lifecycle/host-pane-respawn-capability'
import { BROWSER_CLIENT_HOST_REQUEST_CAPABILITY } from '../../browser/client-hosting/browser-client-host-request-protocol'
import {
  STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY
} from '../../agent-session/requests/structured-chat-dispatch-telemetry'
import { NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from './protocol-version'
import { GOOGLE_SETUP_CARDS_CLIENT_CAPABILITY } from '../../google/google-connect-types'
import {
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY
} from './session-tabs-runtime-capabilities'
import { WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY } from './worktree-runtime-capabilities'
import { LEGACY_JOURNAL_RETIREMENT_FORWARDING_CAPABILITY } from './legacy-journal-retirement-forwarding'
import { ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY } from '../../orchestration/orchestration-runtime-capabilities'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
} from '../../browser/runtime/browser-runtime-capabilities'

// Electron clients can decode client-hosted page placement; becoming a page
// host still requires the separate authenticated browser-client lease.
export const ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  GIT_GRAPH_TAB_CAPABILITY,
  GIT_REVERT_CONFLICT_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY,
  LEGACY_JOURNAL_RETIREMENT_FORWARDING_CAPABILITY,
  ...NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  TERMINAL_IMAGE_VIEWER_CAPABILITY,
  // The renderer remounts a pane whose terminal the host replaced (watchHostRebindAfterExit).
  TERMINAL_HOST_PANE_RESPAWN_CLIENT_CAPABILITY,
  // The renderer that reads a paired host's structured chats is the one that reads its own.
  ...STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  // The renderer starts hosting when a server's page needs a desktop and none holds a lease.
  BROWSER_CLIENT_HOST_REQUEST_CAPABILITY,
  // Why: only the renderer runs the retirement-proof ledger; CLI and mobile must keep full lists.
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  // Main restores every tab-delta frame before the window or any other reader sees it.
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY,
  // Only the renderer shows Deleting for a `removing` row; CLI and mobile get those rows omitted.
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  // The renderer shows a restored, unconfirmed agent row as identity only.
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  // A person answers worker approvals in this window.
  ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY,
  // The renderer draws an agent's Google setup cards, Connect included.
  GOOGLE_SETUP_CARDS_CLIENT_CAPABILITY
] as const
