import { useCallback } from 'react'
import { useAppStore } from '@/store/index'
import {
  agentCliUpdateHostKey,
  agentCliUpdateHostTarget,
  type AgentCliUpdateRun
} from '@/store/slices/runtime-host-updates/agent-cli-updates'
import {
  isAgentCliUpdateAgent,
  type AgentCliUpdate
} from '../../../../shared/agent-launch/installation/agent-cli-update'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type AgentCliUpdateView = {
  /** Set while the user's own CLI on this host is behind its latest release. */
  update: AgentCliUpdate | null
  run: AgentCliUpdateRun | null
  /** The one update action every entry point shares; resolves true once the CLI is current. */
  start: () => Promise<boolean>
}

/** One agent's CLI update on one host, read from the state the status bar item also shows. */
export function useAgentCliUpdate(
  target: RuntimeClientTarget | null | undefined,
  agent: string | undefined
): AgentCliUpdateView {
  const key = target ? agentCliUpdateHostKey(target) : null
  const supported = agent !== undefined && isAgentCliUpdateAgent(agent) ? agent : null
  const host = useAppStore((s) => (key === null ? undefined : s.agentCliUpdates.get(key)))
  const start = useCallback(
    () =>
      key === null || supported === null
        ? Promise.resolve(false)
        : useAppStore.getState().runAgentCliUpdate(agentCliUpdateHostTarget(key), supported),
    [key, supported]
  )
  return {
    update: (supported && host?.updates.find((entry) => entry.agent === supported)) || null,
    run: (supported && host?.runs[supported]) || null,
    start
  }
}
