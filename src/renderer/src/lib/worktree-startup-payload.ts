import type { TuiAgent } from '../../../shared/tui-agent'
import type { EventProps } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import type { AgentLaunchInput } from '../../../shared/agent-launch-spawn-request'

/** Telemetry threaded from the launch site to `pty:spawn`; main fires `agent_started`
 *  only after the spawn succeeds. See telemetry-plan.md§Agent launch semantics. */
export type AgentStartedTelemetry = EventProps<'agent_started'>

/** What a client-threaded startup may carry: `agent_kind` is host-authoritative
 *  (overwritten from the resolved launch receipt before the emit), so a surface
 *  that only names an identity must be able to omit it. */
export type StartupLaunchTelemetry = Omit<AgentStartedTelemetry, 'agent_kind'> &
  Partial<Pick<AgentStartedTelemetry, 'agent_kind'>>

/** Startup command threaded onto a worktree's first terminal at activation. */
export type WorktreeStartupPayload = {
  command: string
  /** Host-owned launch request: the client names the identity (or session to
   *  resume) and prompt policy only. When set it supersedes the
   *  command/launchConfig/launchToken/launchAgent fields below, which the host
   *  reassembles itself — mirrors the queueTabStartupCommand contract this
   *  payload is forwarded to verbatim. */
  agentLaunch?: AgentLaunchInput
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  draftPrompt?: string
  /**
   * The unsent launch context, for the initial view-mode decision ONLY.
   *
   * Deliberately separate from `draftPrompt`, which drives the bracketed paste
   * in pty-connection: an argv-prefill launch already carries the draft inside
   * `command`, so reusing `draftPrompt` here would paste it a second time.
   * Set this on every draft launch; set `draftPrompt` only for paste delivery.
   */
  launchDraftText?: string
  startupCommandDelivery?: StartupCommandDelivery
  initialAgentStatus?: { agent: TuiAgent; prompt: string }
  sessionOptions?: Record<string, SessionOptionValue>
  telemetry?: StartupLaunchTelemetry
}

/**
 * The unsent launch context a startup payload carries, whichever way the agent
 * receives it: argv prefill sets only `launchDraftText`, post-ready paste sets
 * `draftPrompt`. Gating on `draftPrompt` alone silently misses every
 * argv-prefill launch.
 */
export function resolveStartupLaunchDraftText(
  startup: Pick<WorktreeStartupPayload, 'draftPrompt' | 'launchDraftText'> | undefined
): string | undefined {
  return startup?.draftPrompt ?? startup?.launchDraftText
}

/** Shared by both tab-creation sites so the draft gate can't drift between them. */
export function draftViewModeProps(draftText: string | undefined): {
  promptDelivery?: 'draft'
  launchDraftText?: string
} {
  return draftText == null ? {} : { promptDelivery: 'draft', launchDraftText: draftText }
}
