import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import type { AgentHookTarget } from '../../../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  isAgentHookTarget,
  readAgentHookConsent
} from '../../../../shared/agent-hook-listener/configuration/agent-hook-consent'
import { watchAgentTerminalArrivals } from '../terminal-pane/provider-notices/agent-presence/agent-terminal-presence'

export type AgentHookConsentCardOffer = {
  agent: AgentHookTarget
  /** Starts with `agent`; the rest are other detected, undecided agents one Install can cover. */
  agents: AgentHookTarget[]
  configPath: string
}

let current: AgentHookConsentCardOffer | null = null
let resolving = false
const waiting: AgentHookTarget[] = []
// Later lasts until Orca restarts, so the agent's next start after that asks again.
const laterThisRun = new Set<AgentHookTarget>()
const listeners = new Set<() => void>()

function publish(next: AgentHookConsentCardOffer | null): void {
  current = next
  for (const listener of listeners) {
    listener()
  }
}

function isUndecided(agent: AgentHookTarget): boolean {
  return readAgentHookConsent(useAppStore.getState().settings, agent) === null
}

async function showNext(): Promise<void> {
  if (current || resolving) {
    return
  }
  const agent = waiting.shift()
  if (!agent) {
    return
  }
  resolving = true
  try {
    // Main adopts hooks already on disk and finds the other agents one Install can cover.
    const offer = await window.api.agentHookConsent.offer(agent)
    if (offer.ask && isUndecided(agent) && !laterThisRun.has(agent)) {
      // One Install covers only CLIs this computer actually has.
      const detected = new Set<string>(await useAppStore.getState().ensureNativeDetectedAgents())
      publish({
        agent,
        agents: offer.agents.filter(
          (other) => other === agent || (detected.has(other) && !laterThisRun.has(other))
        ),
        configPath: offer.configPath
      })
    }
  } catch (error) {
    console.warn('[agent-hook-consent] could not check hooks for', agent, error)
  } finally {
    resolving = false
  }
  void showNext()
}

function enqueue(agent: string): void {
  if (!isAgentHookTarget(agent) || laterThisRun.has(agent) || !isUndecided(agent)) {
    return
  }
  if (current?.agent === agent || waiting.includes(agent)) {
    return
  }
  waiting.push(agent)
  void showNext()
}

/** Watches terminals for each agent's first appearance this run; returns the unsubscribe. */
export function startAgentHookConsentWatch(): () => void {
  return watchAgentTerminalArrivals(enqueue)
}

/** `later` keeps this agent quiet until Orca restarts; otherwise it was decided. */
export function closeAgentHookConsentOffer(options: { later: boolean }): void {
  if (current && options.later) {
    laterThisRun.add(current.agent)
  }
  publish(null)
  void showNext()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAgentHookConsentOffer(): AgentHookConsentCardOffer | null {
  return useSyncExternalStore(subscribe, () => current)
}
