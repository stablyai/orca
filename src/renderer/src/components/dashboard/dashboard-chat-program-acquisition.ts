import type { AppState } from '@/store'
import { holdChatProgramFacts } from '@/lib/host-chat-program-acquisition'
import { resolveChatProgramContext } from '@/lib/host-chat-program'
import { selectAgentLaunchRouteView, worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { DASHBOARD_MAX_LAUNCH_WORKTREES } from '../../../../shared/dashboard-snapshot'
import { collectActiveDashboardWorkspaces } from './dashboard-snapshot-workspaces'

/** Publishers reconcile one hold per represented execution resource before building payloads. */
export function createDashboardChatProgramHolds() {
  const held = new Map<string, () => void>()
  return {
    reconcile(state: AppState): void {
      const next = new Set<string>()
      const routeStore = selectAgentLaunchRouteView(state)
      const shown = collectActiveDashboardWorkspaces(state, false)
      for (const { worktree } of shown.slice(0, DASHBOARD_MAX_LAUNCH_WORKTREES)) {
        const context = resolveChatProgramContext(routeStore, worktreeLaunchWorkspace(worktree.id))
        const key = context.revision
        next.add(key)
        if (!held.has(key)) {
          // A new hold can notify synchronously and re-enter this reconcile: reserve its key first.
          held.set(key, () => {})
          held.set(key, holdChatProgramFacts(context).release)
        }
      }
      for (const [key, release] of held) {
        if (!next.has(key)) {
          release()
          held.delete(key)
        }
      }
    },
    release(): void {
      held.forEach((release) => release())
      held.clear()
    }
  }
}
