import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import {
  activateWebRuntimeSessionWorktree,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import {
  setWorktreeNavActivator,
  setWorktreeNavViewActivator
} from '@/store/slices/worktree-nav-history'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  folderWorkspaceActivationBlocked,
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'
import { toast } from 'sonner'
import { isDetachedHeadWorkspace } from '@/components/sidebar/visible-worktrees'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'
import type { IssueCommandLaunch } from '@/lib/worktree-setup-issue-command-queue'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import { applyWorktreeNavViewEntry } from '@/lib/worktree-nav-view-history-replay'

/**
 * Shared activation sequence used by the worktree palette and add-repo/worktree dialogs.
 * The caller passes only `worktreeId`; the helper derives `repoId` and returns early
 * without side effects if the worktree is not found (deleted between palette open and select).
 */
export type ActivateAndRevealResult = {
  /** Id of the primary terminal tab seeded with `opts.startup`, or null. Prefer this over
   *  `activeTabIdByWorktree`, which may point at another tab if setup/issue scripts opened their own. */
  primaryTabId: string | null
}

function ensureFolderWorkspaceInitialTerminal(
  folderWorkspace: FolderWorkspace,
  startup?: WorktreeStartupPayload
): string | null {
  const state = useAppStore.getState()
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    state,
    workspaceKey,
    startup,
    undefined,
    undefined,
    undefined
  )
  return primaryTabId
}

export function activateAndRevealFolderWorkspace(
  folderWorkspaceId: string,
  opts?: {
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    startup?: WorktreeStartupPayload
    runtimeEnvironmentId?: string | null
    executionHostId?: ExecutionHostId
  }
): ActivateAndRevealResult | false {
  const state = useAppStore.getState()
  const folderWorkspaceOwner = findFolderWorkspaceOwner(
    state,
    folderWorkspaceId,
    opts?.executionHostId
  )
  const folderWorkspace = state.folderWorkspaces.find(
    (workspace) => workspace === folderWorkspaceOwner
  )
  if (!folderWorkspace) {
    return false
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForWorktree(state, folderWorkspaceKey(folderWorkspaceId))
  const pathStatus = state.getFreshFolderWorkspacePathStatus(
    {
      scope: 'folder-workspace',
      folderWorkspaceId
    },
    { runtimeEnvironmentId }
  )
  if (folderWorkspaceActivationBlocked(pathStatus)) {
    const title =
      getFolderWorkspacePathStatusTitle(pathStatus) ??
      translate(
        'auto.lib.worktree.activation.cannotOpenFolderWorkspace',
        'Cannot open folder workspace'
      )
    toast.error(title, {
      description: getFolderWorkspacePathStatusDescription(pathStatus) ?? folderWorkspace.folderPath
    })
    return false
  }

  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  state.setActiveFolderWorkspace(folderWorkspaceId, opts?.executionHostId)

  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  state.markWorktreeVisited(workspaceKey)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(workspaceKey)
  }
  resumeSleepingAgentSessionsForWorktree(workspaceKey)
  const primaryTabId = ensureFolderWorkspaceInitialTerminal(folderWorkspace, opts?.startup)

  if (opts?.sidebarRevealBehavior) {
    state.revealWorktreeInSidebar(workspaceKey, { behavior: opts.sidebarRevealBehavior })
  } else {
    state.revealWorktreeInSidebar(workspaceKey)
  }

  return { primaryTabId }
}

export function activateAndRevealWorktree(
  worktreeId: string,
  opts?: {
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
  }
): ActivateAndRevealResult | false {
  const state = useAppStore.getState()
  const wt = state.getKnownWorktreeById(worktreeId, opts?.executionHostId)
  if (!wt) {
    return false
  }
  const hasActivationWork = Boolean(
    opts?.startup || opts?.setup || opts?.defaultTabs || opts?.issueCommand
  )
  // Why: a plain reselect should still reveal the sidebar row but must not restamp focus recency or wake persistence.
  const isPlainAlreadyActiveTerminal =
    !hasActivationWork &&
    state.activeRepoId === wt.repoId &&
    state.activeWorktreeId === worktreeId &&
    state.activeWorkspaceExecutionHostId === (opts?.executionHostId ?? null) &&
    state.activeView === 'terminal'

  // 1. Set activeRepoId if crossing repos
  if (wt.repoId !== state.activeRepoId) {
    state.setActiveRepo(wt.repoId)
  }

  // 2. Switch any non-terminal view back to terminal
  if (state.activeView !== 'terminal') {
    state.setActiveView('terminal')
  }

  // 3. Core activation: setActiveWorktree also restores per-worktree state, clears unread, bumps dead PTY generations, refreshes GitHub
  state.setActiveWorktree(worktreeId, opts?.executionHostId)
  const postActivationState = useAppStore.getState()
  const ownerRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(postActivationState, wt.id)
  if (opts?.notifyHostRuntime !== false && isWebRuntimeSessionActive(ownerRuntimeEnvironmentId)) {
    // Why: paired web clients own only local selection, so the desktop host publishes session surfaces without treating it as a nav command.
    void activateWebRuntimeSessionWorktree({
      worktreeId,
      environmentId: ownerRuntimeEnvironmentId
    })
  }

  // Why: focus recency for Cmd+J ordering, distinct from recordWorktreeVisit/lastActivityAt; stamp before any later async step could throw. See docs/cmd-j-empty-query-ordering.md.
  if (!isPlainAlreadyActiveTerminal) {
    state.markWorktreeVisited(worktreeId)
  }

  // Why: skip re-recording for goBack/goForward history navigation — it moves the index instead of visiting anew (isNavigatingHistory).
  if (!isPlainAlreadyActiveTerminal && !state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
  }

  // Why: sleeping destroys the local PTY but preserves the provider session id, so waking should restore those CLI sessions automatically.
  resumeSleepingAgentSessionsForWorktree(worktreeId)

  // 4. Ensure a focusable surface exists for externally-created worktrees
  const primaryTabId = ensureWorktreeHasInitialTerminal(
    useAppStore.getState(),
    worktreeId,
    opts?.startup,
    opts?.setup,
    opts?.issueCommand,
    opts?.defaultTabs,
    opts?.backendStartupTerminalSpawned ? { backendStartupTerminalSpawned: true } : undefined
  )
  if (primaryTabId && opts?.initialCwd) {
    useAppStore.getState().queueTabInitialCwd(primaryTabId, opts.initialCwd)
  }

  // 5. Clear sidebar filters hiding the target — reveal needs the card rendered, else it silently no-ops.
  if (state.filterRepoIds.length > 0 && !state.filterRepoIds.includes(wt.repoId)) {
    state.setFilterRepoIds([])
  }
  if (
    state.hideAutomationGeneratedWorkspaces &&
    wt.automationProvenance?.kind === 'created-by-automation'
  ) {
    state.setHideAutomationGeneratedWorkspaces(false)
  }
  if (state.hideCliCreatedWorkspaces && wt.cliProvenance?.kind === 'created-by-cli') {
    state.setHideCliCreatedWorkspaces(false)
  }
  if (state.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(wt)) {
    state.setHideDetachedHeadWorkspaces(false)
  }

  // 6. Reveal in sidebar
  if (opts?.revealInSidebar !== false) {
    if (opts?.sidebarRevealBehavior || opts?.executionHostId) {
      state.revealWorktreeInSidebar(worktreeId, {
        ...(opts.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {}),
        ...(opts.executionHostId ? { executionHostId: opts.executionHostId } : {})
      })
    } else {
      state.revealWorktreeInSidebar(worktreeId)
    }
  }

  if (opts?.notifyHostRuntime !== false && !opts?.backendStartupTerminalSpawned) {
    ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId)
  }

  return { primaryTabId }
}

/**
 * Activates a sidebar workspace id of either shape. Rendered sidebar order mixes
 * plain worktree ids with `folder:` keys, so every caller that navigates by that
 * order must dispatch here — the folder branch is what enforces the path-status
 * gate that blocks a missing/unmounted/disconnected-SSH folder (#10716).
 */
export function activateAndRevealWorkspace(
  workspaceId: string,
  opts?: { executionHostId?: ExecutionHostId }
): ActivateAndRevealResult | false {
  const workspaceScope = parseWorkspaceKey(workspaceId)
  if (workspaceScope?.type === 'folder') {
    return activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, opts)
  }
  return activateAndRevealWorktree(workspaceId, opts)
}

// Why: break the import cycle — nav-history slice (under @/store) can't import activation directly, so register the activator here.
setWorktreeNavActivator(activateAndRevealWorkspace)

setWorktreeNavViewActivator(applyWorktreeNavViewEntry)
