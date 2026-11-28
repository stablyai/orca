import {
  ClaudeSessionContinuationTracker,
  resolvePaneClaudeContinuation
} from '../../../shared/agent-hook-listener/claude-session-continuation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { probeAgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence-probe'
import type { AgentProcessVerdict } from '../../../shared/agent-status/process/agent-process-presence'
import { AgentProcessExitWatch } from '../../../shared/agent-status/process/agent-process-exit-watch'
import { watchProviderHookExit } from '../../../shared/agent-hook-listener/provider-hook-session'

export class RelayAgentPresence {
  private readonly pending = new WeakMap<
    AgentHookEventPayload,
    Promise<AgentProcessVerdict | null>
  >()
  private readonly exitWatch = new AgentProcessExitWatch()
  private readonly claudeContinuations = new ClaudeSessionContinuationTracker()

  constructor(private readonly state: HookListenerState) {}

  stop(): void {
    this.exitWatch.stopAll()
  }

  watchExit(event: AgentHookEventPayload, probe: () => Promise<AgentProcessVerdict | null>): void {
    watchProviderHookExit(this.state, this.exitWatch, event, probe)
  }

  check(
    row: AgentHookEventPayload | undefined,
    current: () => AgentHookEventPayload | undefined,
    publish: (event: AgentHookEventPayload) => void
  ): Promise<AgentProcessVerdict | null> {
    if (row) {
      this.followClaudeSessionContinuation(row, publish)
    }
    // Why re-read: a rebinding above replaced the cached row the probe must compare against.
    const owner = row ? current() : undefined
    if (!owner?.agentPresence?.process || owner.agentPresence.ended) {
      return Promise.resolve(null)
    }
    const existing = this.pending.get(owner)
    if (existing) {
      return existing
    }
    const presence = owner.agentPresence
    let suspended: boolean | undefined
    const check = probeAgentProcessPresence(presence.process, undefined, undefined, (observed) => {
      suspended = observed
    })
      .then((verdict): AgentProcessVerdict => {
        if (current() !== owner) {
          return 'unverifiable'
        }
        if (verdict === 'exited') {
          publish({
            ...owner,
            isReplay: undefined,
            hookEventName: 'AgentProcessExit',
            agentPresence: { ...presence, ended: true }
          })
        } else if ((suspended === true) !== (presence.suspended === true)) {
          const { suspended: _suspended, ...unsuspended } = presence
          publish({
            ...owner,
            isReplay: undefined,
            hookEventName: undefined,
            hasExplicitPrompt: undefined,
            agentPresence: suspended ? { ...unsuspended, suspended: true } : unsuspended
          })
        }
        return verdict
      })
      .finally(() => this.pending.delete(owner))
    this.pending.set(owner, check)
    return check
  }

  /** Same rebinding as the client's hook server (#24117); the relay owns this host's transcripts. */
  private followClaudeSessionContinuation(
    row: AgentHookEventPayload,
    publish: (event: AgentHookEventPayload) => void
  ): void {
    const next = resolvePaneClaudeContinuation(
      this.claudeContinuations,
      this.state.lastStatusByPaneKey,
      row.paneKey
    )
    if (next) {
      publish({
        ...row,
        providerSession: next,
        isReplay: true,
        hookEventName: undefined,
        hasExplicitPrompt: undefined
      })
    }
  }
}
