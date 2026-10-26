import { isDeepStrictEqual } from 'node:util'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import { foldJcodeRootPayload } from './agent-hook-listener/providers/jcode-roster-state'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'
import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'

type PublishRow = (row: AgentHookEventPayload) => void

export class JcodeSubagentExpiryTimers {
  private readonly wakeups = new CodexSubagentPollScheduler<PublishRow>(0, (paneKey, publish) => {
    const row = this.currentRow(paneKey)
    if (!row) {
      return
    }
    const payload = foldJcodeRootPayload(this.state, paneKey)
    if (payload && !isDeepStrictEqual(payload, row.payload)) {
      publish({
        ...row,
        payload,
        hookEventName: undefined,
        hasExplicitPrompt: undefined,
        promptInteractionKey: undefined
      })
    }
    this.arm(paneKey, publish)
  })

  constructor(private readonly state: HookListenerState) {}

  arm(paneKey: string, publish: PublishRow): void {
    const now = Date.now()
    let deadline = Infinity
    if (this.currentRow(paneKey)) {
      for (const tracked of this.state.jcodeSubagentRosterByPaneKey.get(paneKey)?.values() ?? []) {
        const expiresAt = tracked.lastActivityAt + AGENT_STATUS_STALE_AFTER_MS + 1
        if (tracked.state === 'working' && !tracked.restoredFromSnapshot && expiresAt > now) {
          deadline = Math.min(deadline, expiresAt)
        }
      }
    }
    if (deadline === Infinity) {
      this.wakeups.clear(paneKey)
    } else {
      this.wakeups.schedule(
        paneKey,
        publish,
        Math.min(AGENT_STATUS_STALE_AFTER_MS + 1, deadline - now)
      )
    }
  }

  clearAll(): void {
    this.wakeups.clearAll()
  }

  private currentRow(paneKey: string): AgentHookEventPayload | undefined {
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    return row?.source === 'jcode' &&
      row.payload.agentType === 'jcode' &&
      !row.connectionId &&
      row.providerSession?.key === 'session_id' &&
      row.providerSession?.id === this.state.jcodeSessions.roots.get(paneKey)
      ? row
      : undefined
  }
}
