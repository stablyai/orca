import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import type { DashboardRevealAgentArgs } from '../../../../shared/dashboard-snapshot'

export function revealDashboardAgent(args: DashboardRevealAgentArgs): boolean {
  return revealTerminalPane({
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    executionHostId: args.executionHostId ?? null
  })
}
