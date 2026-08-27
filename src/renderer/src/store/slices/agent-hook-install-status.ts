import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-types'
import type { AgentHookInstallStateByTarget } from '@/lib/agent-status-observability'

export type AgentHookInstallStatusSlice = {
  /**
   * Managed-hook install state per agent, refreshed from the main process.
   *
   * Empty means "not read yet", which is deliberately distinct from an agent
   * mapped to `not_installed` — consumers must not treat an unfetched snapshot
   * as evidence that hooks are missing.
   */
  agentHookInstallStateByTarget: AgentHookInstallStateByTarget
  setAgentHookInstallStatuses: (statuses: readonly AgentHookInstallStatus[]) => void
}

export const createAgentHookInstallStatusSlice: StateCreator<
  AppState,
  [],
  [],
  AgentHookInstallStatusSlice
> = (set, get) => ({
  agentHookInstallStateByTarget: {},

  setAgentHookInstallStatuses: (statuses: readonly AgentHookInstallStatus[]) => {
    const next: AgentHookInstallStateByTarget = {}
    for (const status of statuses) {
      next[status.agent] = status.state
    }
    // Why: this refreshes on a timer, so bail on an unchanged snapshot — a new
    // object identity every tick would re-render every worktree dot for nothing.
    const current = get().agentHookInstallStateByTarget
    const currentKeys = Object.keys(current)
    if (
      currentKeys.length === Object.keys(next).length &&
      currentKeys.every(
        (key) => current[key as keyof typeof current] === next[key as keyof typeof next]
      )
    ) {
      return
    }
    set({ agentHookInstallStateByTarget: next })
  }
})
