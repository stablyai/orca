import { PROGRAM_STATUS_RUNTIME_CAPABILITY } from './program-status/protocol'
import { TERMINAL_QUICK_COMMAND_RUNTIME_CAPABILITIES } from './terminal-quick-command-capabilities'

// Why: hosts without this strip terminal.send's inputKind (zod object drops
// unknown keys), so a mobile xterm query reply would land as ordinary
// floor-taking input. Mobile must not forward replies unless advertised.
export const TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY =
  'terminal.query-reply-input.v1' as const
// Why: without this, prompt request IDs and waitSubmitMs are stripped and a retry would resend raw input.
export const TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY = 'terminal.prompt-delivery.v1' as const
// Why: paired clients may unmount xterm only when the host can return a
// bounded, sequenced scrollback snapshot for lossless reveal.
export const TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY = 'terminal.paired-parking.v1' as const
// Why: a host without it can't tell a later turn end from a restatement, so clients keep main's
// terminal-title completion behavior for its panes.
export const AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY = 'agent-status.turn-ended-at.v1' as const
// Why: terminal.ensureAgentSession params are strict, so an older host rejects `spawnIntent`; a
// host that advertises this also may answer a declared restore with `terminal_spawn_deferred`.
export const TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY = 'terminal.spawn-intent.v1' as const
// Why: older hosts cannot reconcile terminal.create's mutation after losing the reply, so clients may only retry unknown outcomes when advertised.
export const TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'terminal.create-idempotency.v2' as const
// Why: an older host strips terminal.create's unknown `shell` and answers with a terminal running
// the host default shell. That reply is indistinguishable from success, so a client asking for a
// shell must refuse rather than create the wrong one.
export const TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY =
  'terminal.create-shell-selection.v1' as const

export const TERMINAL_RUNTIME_CAPABILITIES = [
  'terminal.binary-stream.v1',
  PROGRAM_STATUS_RUNTIME_CAPABILITY,
  'terminal.multiplex.v1',
  TERMINAL_QUERY_REPLY_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
  TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY,
  AGENT_STATUS_TURN_END_RUNTIME_CAPABILITY,
  TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY,
  ...TERMINAL_QUICK_COMMAND_RUNTIME_CAPABILITIES,
  TERMINAL_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY,
  TERMINAL_CREATE_SHELL_SELECTION_RUNTIME_CAPABILITY
] as const
