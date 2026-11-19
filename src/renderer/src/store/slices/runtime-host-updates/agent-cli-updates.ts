import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import {
  AGENT_CLI_UPDATE_RUNTIME_CAPABILITY,
  type AgentCliUpdate,
  type AgentCliUpdateAgent,
  type AgentCliUpdateRunResult
} from '../../../../../shared/agent-launch/installation/agent-cli-update'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

// Above the host's own ten-minute limit, so its answer always arrives.
const RUN_TIMEOUT_MS = 11 * 60_000
// Chat starts come in bursts; one ask per host in this window is enough.
const CHECK_INTERVAL_MS = 10 * 60_000

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
const checks = new Map<string, Promise<void>>()
const checkedAt = new Map<string, number>()

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
  /** Resolves true once the host reports the CLI current. */
  runAgentCliUpdate: (target: RuntimeClientTarget, agent: AgentCliUpdateAgent) => Promise<boolean>
}

export const createAgentCliUpdatesSlice: StateCreator<AppState, [], [], AgentCliUpdatesSlice> = (
  set,
  get
) => {
  const writeHost = (key: string, write: (host: AgentCliUpdateHost) => AgentCliUpdateHost) =>
    set((state) => {
      const next = new Map(state.agentCliUpdates)
      next.set(key, write(state.agentCliUpdates.get(key) ?? EMPTY_HOST))
      return { agentCliUpdates: next }
    })
  const writeRun = (key: string, agent: AgentCliUpdateAgent, run: AgentCliUpdateRun) =>
    writeHost(key, (host) => ({ ...host, runs: { ...host.runs, [agent]: run } }))
  const hostAnswers = (target: RuntimeClientTarget): boolean =>
    target.kind === 'local' ||
    lastVerifiedRuntimeStatus(
      get().runtimeStatusByEnvironmentId.get(target.environmentId)
    )?.capabilities?.includes(AGENT_CLI_UPDATE_RUNTIME_CAPABILITY) === true

  return {
    agentCliUpdates: new Map(),

    checkAgentCliUpdates: (target) => {
      const key = agentCliUpdateHostKey(target)
      const last = checkedAt.get(key)
      if (!hostAnswers(target) || (last !== undefined && Date.now() - last < CHECK_INTERVAL_MS)) {
        return checks.get(key) ?? Promise.resolve()
      }
      let check = checks.get(key)
      if (!check) {
        checkedAt.set(key, Date.now())
        check = callRuntimeRpc<{ updates: AgentCliUpdate[] }>(target, 'agentCliUpdate.check')
          .then(({ updates }) => {
            // An unchanged answer leaves the store alone, so the status bar doesn't re-render.
            if (!sameUpdates(get().agentCliUpdates.get(key)?.updates ?? [], updates)) {
              writeHost(key, (host) => ({ ...host, updates }))
            }
          })
          .catch((error: unknown) => {
            console.warn('[agent-cli-update] check failed:', error)
          })
          .finally(() => checks.delete(key))
        checks.set(key, check)
      }
      return check
    },

    runAgentCliUpdate: async (target, agent) => {
      const key = agentCliUpdateHostKey(target)
      if (get().agentCliUpdates.get(key)?.runs[agent]?.phase === 'running') {
        return false
      }
      writeRun(key, agent, { phase: 'running' })
      let result: AgentCliUpdateRunResult
      try {
        result = await callRuntimeRpc<AgentCliUpdateRunResult>(
          target,
          'agentCliUpdate.run',
          { agent },
          { timeoutMs: RUN_TIMEOUT_MS }
        )
      } catch (error) {
        result = { ok: false, output: error instanceof Error ? error.message : String(error) }
      }
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
