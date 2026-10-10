// The host's restart-and-resume capabilities, spread together into RUNTIME_CAPABILITIES by
// protocol-version.ts. Import each one from here or its own module.

import { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from './agent-session-continue-interrupted-capability'

// Why: a paired desktop may ask a host for its restart offers on every connection only when the
// host answers that read without building its chat host (a server that never ran a chat stays
// untouched), and may dismiss there only when the host takes named chats: an older host's dismiss
// params were strict and empty, and its only dismissal deleted every device's offers. It also
// promises `offers` witnesses on dismiss and a per-row `origin` for the asking device. A host
// without this is never asked by a paired desktop.
export const AGENT_SESSION_PAIRED_RESTART_OFFERS_RUNTIME_CAPABILITY =
  'agent-session.paired-restart-offers.v1' as const

export const AGENT_SESSION_RESTART_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY,
  AGENT_SESSION_PAIRED_RESTART_OFFERS_RUNTIME_CAPABILITY
] as const
