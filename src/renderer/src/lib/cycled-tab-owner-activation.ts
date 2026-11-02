import { useAppStore } from '@/store'
import type { TypeCyclableTab } from '@/components/terminal/tab-type-cycle'
import { activateStructuredAgentSessionTabOnOwner } from '@/lib/agent-session/structured-agent-session-tab-activation'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import {
  activateBrowserTabOnOwner,
  activateTerminalTabOnOwner
} from './terminal-tab-owner-activation'

/** Keyboard switches must reach the owner like clicks, or a server workspace reopens on its stale pick. */
export function activateCycledTabOnOwner(worktreeId: string | null, next: TypeCyclableTab): void {
  if (!worktreeId) {
    return
  }
  const state = useAppStore.getState()
  if (next.type === 'terminal') {
    const leafId = state.terminalLayoutsByTabId?.[next.id]?.activeLeafId ?? null
    activateTerminalTabOnOwner(worktreeId, next.id, leafId)
  } else if (next.type === 'browser' && next.tabId) {
    activateBrowserTabOnOwner(worktreeId, next.tabId, next.id)
  } else if (next.type === 'agent-session') {
    const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (candidate) => candidate.id === next.tabId
    )
    // A chat names its own host; local chats stay local so paired phones don't follow every stop.
    const target = tab ? structuredAgentSessionTargetForTab(state, tab) : null
    if (target?.kind === 'environment' && isWebRuntimeSessionActive(target.environmentId)) {
      activateStructuredAgentSessionTabOnOwner(worktreeId, next.id, target, { callerOnly: true })
    }
  }
}
