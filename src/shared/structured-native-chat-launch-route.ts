/**
 * The one place that answers "should this launch be a structured native chat session?".
 *
 * Both launch surfaces call it. The renderer asks when a user opens an agent tab
 * (`resolveAgentLaunchRoute`); orchestration asks when it dispatches a worker, because the mode is
 * the user's own default rather than a per-call flag. Keeping the two halves — the settings default
 * and the per-launch feasibility — here is what stops the second caller from growing a copy that
 * drifts.
 */

import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { parseExecutionHostId } from './execution-host'
import type { GlobalSettings } from './global-settings-types'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import {
  CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from './protocol-version'
import type { TuiAgent } from './tui-agent'
import type { WorkspaceLaunchKind } from './workspace-launch-kind'

export type NativeChatDefaultSettings = Pick<
  GlobalSettings,
  'experimentalNativeChat' | 'experimentalStructuredNativeChat' | 'openAgentTabsInChatByDefault'
>

/** Why a launch that the user's default asked to be structured cannot be. */
export type StructuredNativeChatBlocker =
  | 'reused-terminal'
  | 'agent-without-structured-session'
  | 'floating-workspace'
  /** The agent's launch command is overridden, or the launch names its own working directory:
   *  a process shape only a PTY can produce. The configured *arguments* are not read here —
   *  they are a terminal concern the structured transports do not share a vocabulary with. */
  | 'tui-launch-command'
  | 'remote-execution-host'
  | 'project-runtime'
  | 'runtime-capability'
  /** The owning host has not answered yet. Distinct from `runtime-capability`, which is the
   *  host saying no: an unestablished answer must not read as a refusal. */
  | 'runtime-capability-unknown'
  /** This client does not tell a paired host it can read and launch structured sessions. */
  | 'client-capability'

export type StructuredNativeChatSupport =
  | { supported: true }
  | { supported: false; blocker: StructuredNativeChatBlocker }

export type StructuredNativeChatSupportInput = {
  agent: TuiAgent
  executionHostId: string
  /** Capabilities of the host this launch would run on — a paired server's own, not this
   *  machine's. `null` = not yet established. */
  hostCapabilities: readonly string[] | null
  /** What this client advertises to a paired host; read only for `runtime:` hosts. */
  clientCapabilities?: readonly string[]
  /** Host-derived. Absent means the kind was never established, which is not evidence of any kind. */
  workspaceKind?: WorkspaceLaunchKind
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  requiresTuiLaunchCommand?: boolean
  /** An existing PTY agent keeps its execution transport. */
  reusesTerminal?: boolean
}

/** The user's default for a new agent tab: native chat rather than the raw TUI. */
export function agentTabsDefaultToNativeChat(
  settings: Partial<NativeChatDefaultSettings> | null | undefined
): boolean {
  return (
    settings?.experimentalNativeChat === true && settings?.openAgentTabsInChatByDefault === true
  )
}

/** ...and specifically a structured native chat session rather than a terminal rendered as chat. */
export function prefersStructuredNativeChatByDefault(
  settings: Partial<NativeChatDefaultSettings> | null | undefined,
  agent?: string
): boolean {
  return (
    agentTabsDefaultToNativeChat(settings) &&
    (settings?.experimentalStructuredNativeChat === true || agent === 'cursor')
  )
}

function clientChoosesStructuredLaunches(capabilities: readonly string[] | undefined): boolean {
  return (
    capabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) === true &&
    capabilities.includes(STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY)
  )
}

export function resolveStructuredNativeChatSupport(
  input: StructuredNativeChatSupportInput
): StructuredNativeChatSupport {
  // A paired Orca server runs structured sessions itself and answers for them below. An SSH host
  // has no Orca runtime of its own to run one.
  const host = parseExecutionHostId(input.executionHostId)
  if (host?.kind !== 'local' && host?.kind !== 'runtime') {
    return { supported: false, blocker: 'remote-execution-host' }
  }
  if (input.reusesTerminal === true) {
    return { supported: false, blocker: 'reused-terminal' }
  }
  if (!isAgentSessionHandleProvider(input.agent)) {
    return { supported: false, blocker: 'agent-without-structured-session' }
  }
  if (input.workspaceKind === 'floating') {
    return { supported: false, blocker: 'floating-workspace' }
  }
  if (input.requiresTuiLaunchCommand === true) {
    return { supported: false, blocker: 'tui-launch-command' }
  }
  const projectRuntime = input.projectRuntime
  if (projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl') {
    return { supported: false, blocker: 'project-runtime' }
  }
  if (input.hostCapabilities === null) {
    return { supported: false, blocker: 'runtime-capability-unknown' }
  }
  if (!input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return { supported: false, blocker: 'runtime-capability' }
  }
  if (
    input.agent === 'cursor' &&
    !input.hostCapabilities.includes(CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  ) {
    return { supported: false, blocker: 'runtime-capability' }
  }
  if (host.kind === 'runtime') {
    // An older paired host advertises structured sessions but admits them only with its own chat
    // setting on, so a chat opened there could never start; it keeps the terminal it always got.
    if (!input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY)) {
      return { supported: false, blocker: 'runtime-capability' }
    }
    // The host refuses a client that did not say it reads structured sessions, as the browser
    // client does not; that client keeps the host terminal.
    if (
      !clientChoosesStructuredLaunches(input.clientCapabilities) ||
      (input.agent === 'cursor' &&
        !input.clientCapabilities?.includes(CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY))
    ) {
      return { supported: false, blocker: 'client-capability' }
    }
  }
  return { supported: true }
}
