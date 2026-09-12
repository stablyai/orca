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

/** Create time: a shell seeded now would land beside the agent/chat surface this selection is
 *  about to open, so an agent selection counts as a promised surface (#19940). */
export function activationProvidesInitialSurface(
  selection?: WorktreeActivationSurfaceSelection
): boolean {
  return selection?.providesInitialSurface === true || selection?.agent != null
}

/** Deliberately narrower than `activationProvidesInitialSurface`: the async gate's `empty`
 *  outcome is evidence the agent surface never materialised (dead PTY, unreadable census, null
 *  startup plan), so only an explicit caller promise may suppress the fail-closed re-seed —
 *  honouring the agent half strands the workspace with zero tabs and no recovery (STA-5701). */
export function gatedEmptyOutcomeReseedSuppressed(
  selection?: WorktreeActivationSurfaceSelection
): boolean {
  return selection?.providesInitialSurface === true
}
