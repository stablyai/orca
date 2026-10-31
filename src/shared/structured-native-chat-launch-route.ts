/** Share settings defaults and per-launch feasibility between renderer tab launches and orchestration workers to prevent drift. */

import { isAgentSessionHandleProvider } from './agent-session-provider-handle'
import { parseExecutionHostId } from './execution-host'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from './protocol-version'
import type { AgentDefaultSurface } from './native-chat/native-chat-appearance-settings'
import type { TuiAgent } from './tui-agent'
import type { WorkspaceLaunchKind } from './workspace-launch-kind'

/** Keyed by agent id so host-registered agents outside `TuiAgent` read the same preference. */
export type NativeChatDefaultSettings = {
  agentDefaultSurface?: AgentDefaultSurface
  nativeChatProviders?: Readonly<Partial<Record<string, boolean>>>
}

/** Why a launch that the user's default asked to be structured cannot be. */
export type StructuredNativeChatBlocker =
  | 'reused-terminal'
  | 'agent-without-structured-session'
  /** Only PTYs apply a start directory outside the workspace; configured command/arguments do not choose the surface. */
  | 'custom-start-directory'
  | 'remote-execution-host'
  | 'project-runtime'
  | 'runtime-capability'
  /** Unestablished host support is unknown, distinct from an explicit capability refusal. */
  | 'runtime-capability-unknown'
  /** This client does not tell a paired host it can read and launch structured sessions. */
  | 'client-capability'

export type StructuredNativeChatSupport =
  | { supported: true }
  | { supported: false; blocker: StructuredNativeChatBlocker }

export type StructuredNativeChatSupportInput = {
  agent: TuiAgent
  executionHostId: string
  /** Owning host’s capabilities, including paired servers; null means unestablished. */
  hostCapabilities: readonly string[] | null
  /** What this client advertises to a paired host; read only for `runtime:` hosts. */
  clientCapabilities?: readonly string[]
  /** Host-derived. Absent means the kind was never established, which is not evidence of any kind. */
  workspaceKind?: WorkspaceLaunchKind
  projectExecutionKind?: 'host' | 'ssh'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  startsOutsideWorkspaceRoot?: boolean
  /** An existing PTY agent keeps its execution transport. */
  reusesTerminal?: boolean
  /** Without host inventory, offer only Claude/Codex, which every structured host supports. */
  hostStructuredAgents?: readonly string[]
}

/** An explicit per-agent choice wins over the global default surface. */
export function nativeChatPreferenceFor(
  settings: NativeChatDefaultSettings | null | undefined,
  agent: string
): boolean {
  const override = settings?.nativeChatProviders?.[agent]
  return typeof override === 'boolean' ? override : settings?.agentDefaultSurface === 'chat'
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
  // Paired runtimes execute structured sessions themselves; relay SSH hosts cannot.
  const host = parseExecutionHostId(input.executionHostId)
  if (
    input.projectExecutionKind === 'ssh' ||
    (host?.kind !== 'local' && host?.kind !== 'runtime')
  ) {
    return { supported: false, blocker: 'remote-execution-host' }
  }
  if (input.reusesTerminal === true) {
    return { supported: false, blocker: 'reused-terminal' }
  }
  const builtInAgent = isAgentSessionHandleProvider(input.agent)
  if (!builtInAgent && !input.hostStructuredAgents?.includes(input.agent)) {
    return { supported: false, blocker: 'agent-without-structured-session' }
  }
  if (input.startsOutsideWorkspaceRoot === true) {
    return { supported: false, blocker: 'custom-start-directory' }
  }
  const projectRuntime = input.projectRuntime
  if (projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl') {
    return { supported: false, blocker: 'project-runtime' }
  }
  if (input.hostCapabilities === null) {
    return { supported: false, blocker: 'runtime-capability-unknown' }
  }
  if (
    !input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ||
    // A host that does not advertise its registered agents accepts only Claude and Codex.
    (!builtInAgent &&
      !input.hostCapabilities.includes(
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ))
  ) {
    return { supported: false, blocker: 'runtime-capability' }
  }
  if (host.kind === 'runtime') {
    // Older paired hosts gate on their own chat setting, so retain terminal launches without client-launch-mode support.
    if (!input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY)) {
      return { supported: false, blocker: 'runtime-capability' }
    }
    // Hosts refuse unadvertised client support; retain terminals for those clients.
    if (!clientChoosesStructuredLaunches(input.clientCapabilities)) {
      return { supported: false, blocker: 'client-capability' }
    }
  }
  return { supported: true }
}
