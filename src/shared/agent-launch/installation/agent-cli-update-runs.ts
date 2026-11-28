import { withTimeout } from '../../concurrency/promise-timeout-fallback'
import {
  AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdate,
  type AgentCliUpdateAgent,
  type AgentCliUpdateRunResult
} from './agent-cli-update'

// Above the host's ten-minute updater limit plus its waits before and after; a later answer still settles the row.
export const AGENT_CLI_UPDATE_RUN_TIMEOUT_MS = 12 * 60_000
// The host runs three --version probes (5s cap each, some read twice) at a time; 17 agents plus
// release lookups can approach a minute.
export const AGENT_CLI_UPDATE_CHECK_TIMEOUT_MS = 2 * 60_000
// Each update installs a whole CLI (often through npm); dozens at once would swamp the host.
export const AGENT_CLI_UPDATES_AT_ONCE = 3

export type AgentCliUpdateRun =
  /** Waiting for one of the host's few update slots. */
  | { phase: 'queued' }
  | { phase: 'running' }
  | {
      phase: 'failed'
      /** Capped by the host, so the failure view can show all of it. */
      output: string
      /** What Orca ran; absent when nothing ran. */
      command?: string
      finishedAt: number
    }

/** One host's answer about the user's own agent CLIs, and the updates run there from this client. */
export type AgentCliUpdateHost = {
  updates: readonly AgentCliUpdate[]
  runs: Partial<Record<AgentCliUpdateAgent, AgentCliUpdateRun>>
}

export type AgentCliUpdateHostRow = {
  agent: AgentCliUpdateAgent
  update: AgentCliUpdate | null
  run: AgentCliUpdateRun | null
}

export function sameAgentCliUpdates(
  a: readonly AgentCliUpdate[],
  b: readonly AgentCliUpdate[]
): boolean {
  return (
    a.length === b.length &&
    a.every((update, index) => {
      const other = b[index]
      return (
        other?.agent === update.agent &&
        other.installedVersion === update.installedVersion &&
        other.latestVersion === update.latestVersion &&
        other.command === update.command &&
        other.runnable === update.runnable &&
        JSON.stringify(other.models ?? []) === JSON.stringify(update.models ?? [])
      )
    })
  )
}

/** The failed row a run's answer leaves, or null when the update landed. */
export function agentCliUpdateRunAfter(
  result: AgentCliUpdateRunResult,
  finishedAt: number
): AgentCliUpdateRun | null {
  if (result.ok) {
    return null
  }
  return {
    phase: 'failed',
    output: result.output,
    ...(result.command ? { command: result.command } : {}),
    finishedAt
  }
}

/**
 * Calls `agentCliUpdate.run` under the client ceiling. `late` is set when the ceiling answered
 * first, so the caller can still settle the row with the host's real answer. `answered` is false
 * when the host's own answer never arrived (a dropped call or the ceiling), so the result is unknown.
 */
export async function callAgentCliUpdateRun(run: () => Promise<AgentCliUpdateRunResult>): Promise<{
  result: AgentCliUpdateRunResult
  late: Promise<AgentCliUpdateRunResult> | null
  answered: boolean
}> {
  const timedOut: AgentCliUpdateRunResult = {
    ok: false,
    output: `The update did not finish within ${AGENT_CLI_UPDATE_RUN_TIMEOUT_MS / 60_000} minutes.`
  }
  let answered = true
  const call = run().catch((error: unknown): AgentCliUpdateRunResult => {
    answered = false
    return { ok: false, output: error instanceof Error ? error.message : String(error) }
  })
  // Some transports ignore a request timeout, so an updater that never exits would leave the row running for good.
  const result = await withTimeout(call, AGENT_CLI_UPDATE_RUN_TIMEOUT_MS, timedOut)
  return {
    result,
    late: result === timedOut ? call : null,
    answered: answered && result !== timedOut
  }
}

/** Every update offered or run on a host, in the agent list's order. */
export function agentCliUpdateHostRows(host: AgentCliUpdateHost): AgentCliUpdateHostRow[] {
  return AGENT_CLI_UPDATE_AGENTS.filter(
    (agent) => host.runs[agent] || host.updates.some((update) => update.agent === agent)
  ).map((agent) => ({
    agent,
    update: host.updates.find((update) => update.agent === agent) ?? null,
    run: host.runs[agent] ?? null
  }))
}

export function agentCliUpdateBusy(row: Pick<AgentCliUpdateHostRow, 'run'>): boolean {
  return row.run?.phase === 'running' || row.run?.phase === 'queued'
}

/** Rows Update all may start: offered, runnable and not already queued or running. */
export function agentCliUpdateStartable(row: AgentCliUpdateHostRow): boolean {
  return row.update?.runnable === true && !agentCliUpdateBusy(row)
}
