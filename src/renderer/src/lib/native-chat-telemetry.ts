// Share native-chat event names and agent-kind mapping across tab toggles and composer sends.

import { track, tuiAgentToAgentKind } from './telemetry'
import type { NativeChatRuntime } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Accept broad chat identities and narrow unknowns to telemetry other; callers need no unsafe TuiAgent cast. */
export type NativeChatTelemetryAgent = TuiAgent | (string & {}) | null | undefined

// Plain shells/manual agents may lack launchAgent and chat identities can be unknown; use other so telemetry still validates.
function resolveAgentKind(agent: NativeChatTelemetryAgent): ReturnType<typeof tuiAgentToAgentKind> {
  // tuiAgentToAgentKind does a keyed lookup with an `'other'` fallback, so any
  // string narrows safely; the cast only satisfies its TuiAgent parameter type.
  return agent ? tuiAgentToAgentKind(agent as TuiAgent) : 'other'
}

export function emitNativeChatToggled(args: {
  from: 'terminal' | 'chat'
  to: 'terminal' | 'chat'
  agent: NativeChatTelemetryAgent
}): void {
  track('native_chat_toggled', {
    from_mode: args.from,
    to_mode: args.to,
    agent_kind: resolveAgentKind(args.agent)
  })
}

/** Emit composer sends with resolved PTY runtime, or unknown when ownership cannot be established. */
export function emitNativeChatMessageSent(args: {
  agent: NativeChatTelemetryAgent
  runtime: NativeChatRuntime
}): void {
  track('native_chat_message_sent', {
    agent_kind: resolveAgentKind(args.agent),
    runtime: args.runtime
  })
}

export function emitNativeChatPickerOpened(args: {
  agent: NativeChatTelemetryAgent
  prefix: '/' | '$'
}): void {
  track('native_chat_picker_opened', {
    agent_kind: resolveAgentKind(args.agent),
    prefix: args.prefix === '/' ? 'slash' : 'dollar'
  })
}

export function emitNativeChatPickerItemAccepted(args: {
  agent: NativeChatTelemetryAgent
  itemKind: 'command' | 'skill'
}): void {
  track('native_chat_picker_item_accepted', {
    agent_kind: resolveAgentKind(args.agent),
    item_kind: args.itemKind
  })
}

export function emitNativeChatSendClassified(args: {
  agent: NativeChatTelemetryAgent
  outcome: 'chat' | 'command' | 'unknown-token'
}): void {
  track('native_chat_send_classified', {
    agent_kind: resolveAgentKind(args.agent),
    outcome: args.outcome
  })
}

export function emitNativeChatSkillDiscovery(args: {
  agent: NativeChatTelemetryAgent
  outcome: 'ready' | 'error' | 'timeout' | 'unavailable'
  executionHostKind: 'local' | 'runtime' | 'ssh'
}): void {
  track('native_chat_skill_discovery', {
    agent_kind: resolveAgentKind(args.agent),
    outcome: args.outcome,
    execution_host_kind: args.executionHostKind
  })
}
