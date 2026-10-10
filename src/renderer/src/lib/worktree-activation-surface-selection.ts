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
  /** Set only where the user deliberately opened this existing workspace; absent keeps the shell seed. */
  navigationIntent?: 'user-open'
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
  /** Explicit request to see the workspace in the list: leave the activity view once activation commits. */
  showWorkspaceList?: boolean
  executionHostId?: ExecutionHostId
  backendStartupTerminalSpawned?: boolean
  /** Install a preserved fallback startup beside setup/default terminals already seeded. */
  createNewTerminalForStartup?: boolean
  /** Keep sidebar filters intact when navigating to a hidden target. */
  clearSidebarFilters?: boolean
}

/** Create-time only: an agent selection suppresses the shell its own surface will replace. */
export function activationProvidesInitialSurface(
  selection?: WorktreeActivationSurfaceSelection
): boolean {
  return selection?.providesInitialSurface === true || selection?.agent != null
}

/** A deliberate user open with no surface choice: an empty workspace gets the user's default surface. */
export function activationSeedsUserDefaultSurface(
  selection?: WorktreeActivationSurfaceSelection
): boolean {
  return (
    selection?.navigationIntent === 'user-open' &&
    selection.agent === undefined &&
    selection.providesInitialSurface !== true
  )
}
