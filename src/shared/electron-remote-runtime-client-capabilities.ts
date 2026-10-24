import { STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES } from './structured-agent-session-renderer-client-capabilities'
import { TERMINAL_IMAGE_VIEWER_CAPABILITY } from './terminal-image-viewer-capability'
import {
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY,
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY
} from './protocol-version'

// Electron clients can decode client-hosted page placement; becoming a page
// host still requires the separate authenticated browser-client lease.
export const ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  ...NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  TERMINAL_IMAGE_VIEWER_CAPABILITY,
  // The renderer that reads a paired host's structured chats is the one that reads its own.
  ...STRUCTURED_AGENT_SESSION_RENDERER_CLIENT_CAPABILITIES,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  // Why: only the renderer runs the retirement-proof ledger; CLI and mobile must keep full lists.
  SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY,
  // Main restores every tab-delta frame before the window or any other reader sees it.
  SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY,
  // Only the renderer shows Deleting for a `removing` row; CLI and mobile get those rows omitted.
  WORKTREE_BACKGROUND_REMOVAL_RUNTIME_CAPABILITY,
  // The renderer shows a restored, unconfirmed agent row as identity only.
  AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY
] as const
