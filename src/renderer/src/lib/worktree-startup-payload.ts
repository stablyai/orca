import type { TuiAgent } from '../../../shared/tui-agent'
import type { EventProps } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'

/** Telemetry threaded from the launch site to `pty:spawn`; main fires `agent_started`
 *  only after the spawn succeeds. See telemetry-plan.md§Agent launch semantics. */
export type AgentStartedTelemetry = EventProps<'agent_started'>

/** Startup command threaded onto a worktree's first terminal at activation. */
export type WorktreeStartupPayload = {
  command: string
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
  telemetry?: AgentStartedTelemetry
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
