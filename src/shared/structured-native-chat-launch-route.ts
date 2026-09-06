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
import type { GlobalSettings } from './global-settings-types'
import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from './protocol-version'
import type { TuiAgent } from './tui-agent'

export type NativeChatDefaultSettings = Pick<
  GlobalSettings,
  'experimentalNativeChat' | 'experimentalStructuredNativeChat' | 'openAgentTabsInChatByDefault'
>

/** Why a launch that the user's default asked to be structured cannot be. */
export type StructuredNativeChatBlocker =
  | 'agent-without-structured-session'
  | 'draft-prompt'
  | 'floating-workspace'
  | 'tui-launch-customization'
  | 'remote-execution-host'
  | 'codex-on-windows'
  | 'project-runtime'
  | 'runtime-capability'

export type StructuredNativeChatSupport =
  | { supported: true }
  | { supported: false; blocker: StructuredNativeChatBlocker }

export type StructuredNativeChatSupportInput = {
  agent: TuiAgent
  executionHostId: string
  platform: NodeJS.Platform
  hostCapabilities: readonly string[]
  workspaceKind?: 'git-worktree' | 'folder' | 'floating'
  projectRuntime?: ProjectExecutionRuntimeResolution | null
  /** A draft stays terminal-backed: the composer, not a turn, owns unsent text. */
  isDraftPrompt?: boolean
  requiresTuiLaunchCustomization?: boolean
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

export function resolveStructuredNativeChatSupport(
  input: StructuredNativeChatSupportInput
): StructuredNativeChatSupport {
  if (!isAgentSessionHandleProvider(input.agent)) {
    return { supported: false, blocker: 'agent-without-structured-session' }
  }
  if (input.isDraftPrompt === true) {
    return { supported: false, blocker: 'draft-prompt' }
  }
  if (input.workspaceKind === 'floating') {
    return { supported: false, blocker: 'floating-workspace' }
  }
  if (input.requiresTuiLaunchCustomization === true) {
    return { supported: false, blocker: 'tui-launch-customization' }
  }
  if (input.executionHostId !== 'local') {
    return { supported: false, blocker: 'remote-execution-host' }
  }
  // Codex's Windows refusal is deliberate and settled elsewhere, so it stays a client-side answer.
  // Claude's is measured by the executing host at create time (agentSession.createSupport) because
  // only that host knows whether it can read a provider child's start time.
  if (input.agent === 'codex' && input.platform === 'win32') {
    return { supported: false, blocker: 'codex-on-windows' }
  }
  const projectRuntime = input.projectRuntime
  if (projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl') {
    return { supported: false, blocker: 'project-runtime' }
  }
  if (!input.hostCapabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return { supported: false, blocker: 'runtime-capability' }
  }
  return { supported: true }
}
