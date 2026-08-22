import {
  createAgentOutputStatusDetector,
  type AgentOutputStatusDetector,
  type AgentOutputStatusProfile
} from './agent-output-status-detector'
import { BOB_OUTPUT_STATUS_PROFILE } from './bob-output-status'
import { COMMAND_CODE_OUTPUT_STATUS_PROFILE } from './command-code-output-status'
import type { TuiAgent } from './tui-agent'

/** Agents whose working / waiting / done rows are scraped from rendered output. */
export const AGENT_OUTPUT_STATUS_PROFILES: readonly AgentOutputStatusProfile[] = [
  COMMAND_CODE_OUTPUT_STATUS_PROFILE,
  BOB_OUTPUT_STATUS_PROFILE
]

export function isOutputStatusAgent(agent: string | null | undefined): agent is TuiAgent {
  return AGENT_OUTPUT_STATUS_PROFILES.some((profile) => profile.agent === agent)
}

export type AgentOutputStatusObserverArgs = {
  startupCommand?: string | null
  /** Per-agent continuity seed; see AgentOutputStatusDetectorArgs.inFlightTurn. */
  readInFlightTurn?: (agent: TuiAgent) => { prompt: string } | null
  onWorking: (agent: TuiAgent, prompt: string) => void
  onDone?: (agent: TuiAgent, prompt: string) => void
  onWaiting?: (agent: TuiAgent, prompt: string) => void
}

/** One observer per PTY running every profile. Every detector sees every chunk (each keeps
 *  its own rolling window); a PTY normally arms only one profile, and the write side's
 *  pane-ownership gate decides which agent may own the status row if two ever fire. */
export function createAgentOutputStatusObserver(
  args: AgentOutputStatusObserverArgs,
  profiles: readonly AgentOutputStatusProfile[] = AGENT_OUTPUT_STATUS_PROFILES
): AgentOutputStatusDetector {
  const detectors = profiles.map((profile) =>
    createAgentOutputStatusDetector(profile, {
      startupCommand: args.startupCommand,
      inFlightTurn: args.readInFlightTurn?.(profile.agent) ?? null,
      onWorking: (prompt) => args.onWorking(profile.agent, prompt),
      onDone: (prompt) => args.onDone?.(profile.agent, prompt),
      onWaiting: (prompt) => args.onWaiting?.(profile.agent, prompt)
    })
  )
  return {
    observe(data: string): boolean {
      // Why: every detector must see every chunk to keep its rolling window,
      // even after one of them has already claimed this chunk's status.
      let fired = false
      for (const detector of detectors) {
        if (detector.observe(data)) {
          fired = true
        }
      }
      return fired
    }
  }
}
