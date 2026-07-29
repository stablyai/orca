// Native-chat adoption telemetry emit wrappers.
//
// Why a dedicated module: the toggle action (store, `tabs.ts`) and the
// composer send path (`NativeChatComposer.tsx`, owned by another unit) both
// need to fire native-chat events, but neither should hand-build the event
// shape inline. Centralizing the `agent_kind` mapping and the
// `track(...)`-name pairing here keeps both call sites in lockstep and gives
// the composer a single import (`emitNativeChatMessageSent`) to call.

import { track, tuiAgentToAgentKind } from './telemetry'
import type { NativeChatRuntime } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'

/** Loose agent type accepted by these emitters: the strict launch `TuiAgent`, or
 *  the broader `AgentType` string carried by the chat view. Narrowing to the
 *  closed `agent_kind` enum (with an `'other'` fallback) happens here so call
 *  sites never need an unsound `as TuiAgent` cast. */
export type NativeChatTelemetryAgent = TuiAgent | string | null | undefined

// `launchAgent` is optional on terminal tabs (plain shells, manually-started
// agents) and the chat view's `AgentType` may carry a string outside the
// `TuiAgent` union. When absent or unknown we fall back to `'other'` so the
// closed `agent_kind` enum still validates instead of dropping the event.
function resolveAgentKind(agent: NativeChatTelemetryAgent): ReturnType<typeof tuiAgentToAgentKind> {
  // tuiAgentToAgentKind does a keyed lookup with an `'other'` fallback, so any
  // string narrows safely; the cast only satisfies its TuiAgent parameter type.
  return agent ? tuiAgentToAgentKind(agent as TuiAgent) : 'other'
}

/** Fire `native_chat_toggled` when a tab flips between terminal and chat. */
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

/**
 * Fire `native_chat_message_sent` when a prompt is sent from the native
 * composer into the running agent. `runtime` is `'unknown'` when the caller
 * cannot resolve whether the owning PTY is local or remote (SSH).
 *
 * The composer (`NativeChatComposer.tsx`, owned by another unit) is the
 * intended caller — it owns the send path and the local/remote runtime
 * resolution. This unit only provides the wrapper.
 */
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
