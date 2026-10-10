import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { probeAgentProcessPresence } from '../shared/agent-process-presence-probe'

export class RelayAgentPresence {
  private readonly pending = new WeakMap<AgentHookEventPayload, Promise<void>>()

  check(
    row: AgentHookEventPayload | undefined,
    current: () => AgentHookEventPayload | undefined,
    publish: (event: AgentHookEventPayload) => void
  ): Promise<void> {
    if (!row?.agentPresence?.process || row.agentPresence.ended) {
      return Promise.resolve()
    }
    const existing = this.pending.get(row)
    if (existing) {
      return existing
    }
    const presence = row.agentPresence
    const check = probeAgentProcessPresence(presence.process)
      .then((verdict) => {
        if (verdict === 'exited' && current() === row) {
          publish({
            ...row,
            hookEventName: 'AgentProcessExit',
            agentPresence: { ...presence, ended: true }
          })
        }
      })
      .finally(() => this.pending.delete(row))
    this.pending.set(row, check)
    return check
  }
}
