import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { StructuredAgentLaunchSettlement } from '@/lib/agent-session/launch/continuation/structured-agent-launch-settlement'
import { structuredAgentSessionTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'

/** A host-published chat tab can trail its settlement; stop looking after this. */
const CHAT_TAB_WAIT_MS = 60_000

function chatTabIdFor(state: AppState, worktreeId: string, sessionId: string): string | null {
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.contentType === 'agent-session' && candidate.entityId === sessionId
  )
  return tab?.id ?? null
}

/**
 * Files a chat launched from a task group under it. A chat row is addressed either by its tab's
 * own id or, for a legacy slot tab, by the id derived from its session, so both are filed.
 */
export function fileChatInTaskGroupWhenSettled(args: {
  settlement: Promise<StructuredAgentLaunchSettlement>
  worktreeId: string
  assign: (tabId: string) => void
}): void {
  void args.settlement.then(
    (settled) => {
      if (settled.kind !== 'structured' && settled.kind !== 'visibility-unknown') {
        return
      }
      const { sessionId } = settled
      args.assign(structuredAgentSessionTabId(sessionId))
      const present = chatTabIdFor(useAppStore.getState(), args.worktreeId, sessionId)
      if (present) {
        args.assign(present)
        return
      }
      const stop = (): void => {
        clearTimeout(timer)
        unsubscribe()
      }
      const unsubscribe = useAppStore.subscribe((state) => {
        const tabId = chatTabIdFor(state, args.worktreeId, sessionId)
        if (tabId) {
          stop()
          args.assign(tabId)
        }
      })
      const timer = setTimeout(stop, CHAT_TAB_WAIT_MS)
    },
    () => {}
  )
}
