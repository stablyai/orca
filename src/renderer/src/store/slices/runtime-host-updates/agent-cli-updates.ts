import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { runtimeStatusSubscriptionsFor } from '../runtime-status/views/runtime-status-subscriptions'
import {
  AGENT_CLI_UPDATE_AGENTS,
  AGENT_CLI_UPDATE_RUNTIME_CAPABILITY,
  type AgentCliUpdate,
  type AgentCliUpdateAgent,
  type AgentCliUpdateRunResult
} from '../../../../../shared/agent-launch/installation/agent-cli-update'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { subscribeRuntimeRpc } from '@/runtime/rpc/subscriptions/runtime-rpc-subscribe'

// Above the host's two-minute updater limit plus its waits before and after, so its answer normally arrives.
const RUN_TIMEOUT_MS = 3 * 60_000
// Chat starts come in bursts; one ask per host in this window is enough.
const CHECK_INTERVAL_MS = 10 * 60_000
// Opening the update list checks sooner; a CLI updated in a terminal sends no finish event.
const OPEN_CHECK_INTERVAL_MS = 10_000
// The host runs three --version probes (5s cap each, some read twice) at a time; 17 agents plus
// release lookups can approach a minute.
const CHECK_TIMEOUT_MS = 2 * 60_000

export type AgentCliUpdateRun =
  | { phase: 'running' }
  | {
      phase: 'failed'
      /** Capped by the host, so the failure dialog can show all of it. */
      output: string
      /** What Orca ran; absent when nothing ran. */
      command?: string
      finishedAt: number
    }

/** One host's answer about the user's own agent CLIs, and the updates run there from this window. */
export type AgentCliUpdateHost = {
  updates: readonly AgentCliUpdate[]
  runs: Partial<Record<AgentCliUpdateAgent, AgentCliUpdateRun>>
}

/** '' is this computer; otherwise the paired server's environment id. */
export function agentCliUpdateHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? '' : target.environmentId
}

export function agentCliUpdateHostTarget(key: string): RuntimeClientTarget {
  return key === '' ? { kind: 'local' } : { kind: 'environment', environmentId: key }
}

const EMPTY_HOST: AgentCliUpdateHost = { updates: [], runs: {} }
const LOCAL_TARGET = { kind: 'local' } as const
const checks = new Map<string, Promise<void>>()
const checkedAt = new Map<string, number>()
// Whether this window follows this computer's finished updates; paired hosts announce them as client events.
let followsLocal = false
// Hosts with a re-check already waiting on an answer in flight; more finished updates join it.
const rechecking = new Set<string>()

function sameUpdates(a: readonly AgentCliUpdate[], b: readonly AgentCliUpdate[]): boolean {
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

export type AgentCliUpdatesSlice = {
  agentCliUpdates: ReadonlyMap<string, AgentCliUpdateHost>
  /** Asks the host which of the user's own CLIs are behind; the host caches its answer. */
  checkAgentCliUpdates: (target: RuntimeClientTarget) => Promise<void>
  /** Checks again now, after any answer already on its way, e.g. once an update finished on the host. */
  recheckAgentCliUpdates: (target: RuntimeClientTarget) => void
  /** Checks as `checkAgentCliUpdates` does, but past a much shorter interval, when the user opens the list. */
  checkAgentCliUpdatesOnOpen: (target: RuntimeClientTarget) => Promise<void>
  /** Drops the answers of paired hosts that were removed or re-paired; a disconnected host keeps its own. */
  forgetAgentCliUpdateHosts: (environmentIds: readonly string[]) => void
  /** Resolves true once the host reports the CLI current. */
  runAgentCliUpdate: (target: RuntimeClientTarget, agent: AgentCliUpdateAgent) => Promise<boolean>
}

export const createAgentCliUpdatesSlice: StateCreator<AppState, [], [], AgentCliUpdatesSlice> = (
  set,
  get,
  store
) => {
  const writeHost = (key: string, write: (host: AgentCliUpdateHost) => AgentCliUpdateHost) =>
    set((state) => {
      // A run result from a removed host must not list it again.
      if (state.removedRuntimeEnvironmentIds.has(key)) {
        return state
      }
      const next = new Map(state.agentCliUpdates)
      next.set(key, write(state.agentCliUpdates.get(key) ?? EMPTY_HOST))
      return { agentCliUpdates: next }
    })
  const writeRun = (key: string, agent: AgentCliUpdateAgent, run: AgentCliUpdateRun) =>
    writeHost(key, (host) => ({ ...host, runs: { ...host.runs, [agent]: run } }))
  const hostAnswers = (target: RuntimeClientTarget): boolean =>
    target.kind === 'local' ||
    lastVerifiedRuntimeStatus(
      runtimeStatusSubscriptionsFor(store).readStatuses().get(target.environmentId)
    )?.capabilities?.includes(AGENT_CLI_UPDATE_RUNTIME_CAPABILITY) === true
  // An update run from any window re-checks here at once, so this window drops its older answer.
  const followLocal = (): void => {
    if (followsLocal) {
      return
    }
    followsLocal = true
    const lose = (): void => {
      followsLocal = false
    }
    subscribeRuntimeRpc(LOCAL_TARGET, 'agentCliUpdate.subscribe', null, {
      onEvent: (result) => {
        if (typeof result === 'object' && result !== null && 'agent' in result && result.agent) {
          get().recheckAgentCliUpdates(LOCAL_TARGET)
        }
      },
      onError: lose,
      onClose: lose
    }).catch(lose)
  }
  const checkPastInterval = (target: RuntimeClientTarget, interval: number): Promise<void> => {
    const key = agentCliUpdateHostKey(target)
    const last = checkedAt.get(key)
    if (!hostAnswers(target)) {
      return checks.get(key) ?? Promise.resolve()
    }
    if (target.kind === 'local') {
      followLocal()
    }
    if (last !== undefined && Date.now() - last < interval) {
      return checks.get(key) ?? Promise.resolve()
    }
    let check = checks.get(key)
    if (!check) {
      checkedAt.set(key, Date.now())
      // A host forgotten meanwhile (removed or re-paired) must not get this answer or its failure.
      const current = (): boolean => checks.get(key) === check
      check = callRuntimeRpc<{ updates: AgentCliUpdate[] }>(
        target,
        'agentCliUpdate.check',
        { agents: AGENT_CLI_UPDATE_AGENTS },
        { timeoutMs: CHECK_TIMEOUT_MS }
      )
        .then(({ updates }) => {
          // An unchanged answer leaves the store alone, so the status bar doesn't re-render.
          if (current() && !sameUpdates(get().agentCliUpdates.get(key)?.updates ?? [], updates)) {
            writeHost(key, (host) => ({ ...host, updates }))
          }
        })
        .catch((error: unknown) => {
          // Still asked (so rechecks apply), but a failure must not hold off the next ask for the interval.
          if (current()) {
            checkedAt.set(key, 0)
          }
          console.warn('[agent-cli-update] check failed:', error)
        })
        .finally(() => {
          if (current()) {
            checks.delete(key)
          }
        })
      checks.set(key, check)
    }
    return check
  }

  return {
    agentCliUpdates: new Map(),

    checkAgentCliUpdates: (target) => checkPastInterval(target, CHECK_INTERVAL_MS),

    checkAgentCliUpdatesOnOpen: (target) => checkPastInterval(target, OPEN_CHECK_INTERVAL_MS),

    forgetAgentCliUpdateHosts: (environmentIds) => {
      environmentIds.forEach((id) => {
        checkedAt.delete(id)
        checks.delete(id)
      })
      set((state) => {
        const next = new Map(state.agentCliUpdates)
        environmentIds.forEach((id) => next.delete(id))
        return next.size === state.agentCliUpdates.size ? state : { agentCliUpdates: next }
      })
    },

    recheckAgentCliUpdates: (target) => {
      const key = agentCliUpdateHostKey(target)
      // Only a host this window has asked before; an answer still on its way may predate the update.
      if (!checkedAt.has(key) || rechecking.has(key)) {
        return
      }
      rechecking.add(key)
      void (checks.get(key) ?? Promise.resolve()).then(() => {
        rechecking.delete(key)
        // Past the interval, so this checks now, while the host stays one this window asked.
        checkedAt.set(key, 0)
        return get().checkAgentCliUpdates(target)
      })
    },

    runAgentCliUpdate: async (target, agent) => {
      const key = agentCliUpdateHostKey(target)
      if (get().agentCliUpdates.get(key)?.runs[agent]?.phase === 'running') {
        return false
      }
      writeRun(key, agent, { phase: 'running' })
      const timedOut: AgentCliUpdateRunResult = {
        ok: false,
        output: `The update did not finish within ${RUN_TIMEOUT_MS / 60_000} minutes.`
      }
      // Local calls ignore timeoutMs, so an updater that never exits would leave the row running for good.
      const result = await withTimeout(
        callRuntimeRpc<AgentCliUpdateRunResult>(
          target,
          'agentCliUpdate.run',
          { agent },
          { timeoutMs: RUN_TIMEOUT_MS }
        ).catch((error: unknown): AgentCliUpdateRunResult => ({
          ok: false,
          output: error instanceof Error ? error.message : String(error)
        })),
        RUN_TIMEOUT_MS,
        timedOut
      )
      if (!result.ok) {
        writeRun(key, agent, {
          phase: 'failed',
          output: result.output,
          ...(result.command ? { command: result.command } : {}),
          finishedAt: Date.now()
        })
        return false
      }
      writeHost(key, (host) => {
        const runs = { ...host.runs }
        delete runs[agent]
        return { updates: host.updates.filter((update) => update.agent !== agent), runs }
      })
      return true
    }
  }
}
