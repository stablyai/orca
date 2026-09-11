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
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from './execution-host'
import type { GlobalSettings } from './global-settings-types'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from './protocol-version'
import type { TuiAgent } from './tui-agent'

export type NativeChatDefaultSettings = Pick<
  GlobalSettings,
  | 'experimentalNativeChat'
  | 'experimentalStructuredNativeChat'
  | 'openAgentTabsInChatByDefault'
  | 'structuredChatRemoteCreate'
>

/** Why a launch that the user's default asked to be structured cannot be. */
export type StructuredNativeChatBlocker =
  | 'reused-terminal'
  | 'agent-without-structured-session'
  | 'floating-workspace'
  | 'tui-launch-customization'
  | 'remote-execution-host'
  /** A paired host that could run this, on a client whose remote-create switch is still off. */
  | 'remote-create-disabled'
  | 'project-runtime'
  | 'runtime-capability'
  /** The owning host has not answered yet. Distinct from `runtime-capability`, which is the
   *  host saying no: an unestablished answer must not read as a refusal. */
  | 'runtime-capability-unknown'
  /** The host advertises the capability but its own structured-chat policy is off. */
  | 'host-policy-disabled'
  /** This client holds no live pairing with the host, so nothing can be created on it. */
  | 'host-disconnected'

/** The subset a client can establish from the owning host's published status alone. */
export type StructuredNativeChatHostStatusBlocker = Extract<
  StructuredNativeChatBlocker,
  'host-policy-disabled' | 'host-disconnected'
>

export type StructuredNativeChatSupport =
  | { supported: true }
  | { supported: false; blocker: StructuredNativeChatBlocker }

export type StructuredNativeChatSupportInput = {
  agent: TuiAgent
  executionHostId: string
  /** Capabilities of the host this launch would run on. `null` = not yet established. */
  hostCapabilities: readonly string[] | null
  /** A refusal the owning host's own published status already establishes. Only a `runtime:`
   *  host produces one; a local or SSH host leaves it unset. */
  hostStatusBlocker?: StructuredNativeChatHostStatusBlocker | null
  workspaceKind?: 'git-worktree' | 'folder' | 'floating'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  requiresTuiLaunchCustomization?: boolean
  /** An existing PTY agent keeps its execution transport. */
  reusesTerminal?: boolean
  /** The client's own switch for creating on a paired host. Absent reads as off. */
  remoteCreateEnabled?: boolean
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
  settings: Partial<NativeChatDefaultSettings> | null | undefined
): boolean {
  return (
    agentTabsDefaultToNativeChat(settings) && settings?.experimentalStructuredNativeChat === true
  )
}

/** The kill switch for starting a structured chat on a paired host. Absent settings are a user who
 *  has never been offered it, which is not consent, so only an explicit `true` turns it on. */
export function structuredNativeChatRemoteCreateEnabled(
  settings: Partial<NativeChatDefaultSettings> | null | undefined
): boolean {
  return settings?.structuredChatRemoteCreate === true
}

/**
 * A non-local host is only ever a paired `runtime:` peer. `ssh:` has no client RPC path to a
 * structured session at all, so it stays refused whatever the switch says.
 *
 * Feasibility beyond reachability is the peer's own answer, not this table's: its createSupport
 * probe is where a Windows peer refuses on the process-start-time proof it cannot obtain.
 */
function remoteExecutionHostBlocker(
  input: StructuredNativeChatSupportInput
): StructuredNativeChatBlocker | null {
  if (input.executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  if (parseExecutionHostId(input.executionHostId)?.kind !== 'runtime') {
    return 'remote-execution-host'
  }
  return input.remoteCreateEnabled === true ? null : 'remote-create-disabled'
}

export function resolveStructuredNativeChatSupport(
  input: StructuredNativeChatSupportInput
): StructuredNativeChatSupport {
  const remoteBlocker = remoteExecutionHostBlocker(input)
  if (remoteBlocker) {
    return { supported: false, blocker: remoteBlocker }
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
  if (input.requiresTuiLaunchCustomization === true) {
    return { supported: false, blocker: 'tui-launch-customization' }
  }
  const projectRuntime = input.projectRuntime
  if (projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl') {
    return { supported: false, blocker: 'project-runtime' }
  }
  // Read before the capability list: a host that is gone or has the feature switched off is
  // answering about itself, and its advertised capabilities cannot overrule that.
  if (input.hostStatusBlocker) {
    return { supported: false, blocker: input.hostStatusBlocker }
  }
  if (input.hostCapabilities === null) {
    return { supported: false, blocker: 'runtime-capability-unknown' }
  }
  if (!input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return { supported: false, blocker: 'runtime-capability' }
  }
  return { supported: true }
}
