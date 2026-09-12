import type { TuiAgent } from '../../../shared/tui-agent'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import type { IssueCommandLaunch } from '@/lib/worktree-setup-issue-command-queue'

export type WorktreeActivationSurfaceSelection = {
  /** The create picker's selection; null means Blank Terminal. */
  agent?: TuiAgent | null
  /** A navigation caller is about to open its own editor, diff, or other non-terminal surface. */
  providesInitialSurface?: boolean
}

export type WorktreeActivationOptions = WorktreeActivationSurfaceSelection & {
  /** Prefer this existing split group when creating an explicit startup terminal. */
  targetGroupId?: string
  startup?: WorktreeStartupPayload
  initialCwd?: string
  setup?: WorktreeSetupLaunch
  defaultTabs?: WorktreeDefaultTabsLaunch
  issueCommand?: IssueCommandLaunch
  sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
  notifyHostRuntime?: boolean
  revealInSidebar?: boolean
  executionHostId?: ExecutionHostId
  backendStartupTerminalSpawned?: boolean
  /** Install a preserved fallback startup beside setup/default terminals already seeded. */
  createNewTerminalForStartup?: boolean
  /** Keep sidebar filters intact when navigating to a hidden target. */
  clearSidebarFilters?: boolean
}

export function activationProvidesInitialSurface(
  selection?: WorktreeActivationSurfaceSelection
): boolean {
  return selection?.providesInitialSurface === true || selection?.agent != null
}
