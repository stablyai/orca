import {
  presentDesktopWorkspace,
  beginDesktopNavigation,
  canPresentDesktopNavigation
} from './desktop-navigation'
import { canInspectAgentActivationInventory } from './worktree-activation-pty-inventory'
import { openDesktopWorkbench } from '@/components/threads/thread-navigation'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import { workspaceHasSleepingAgentSessions } from './worktree-agent-activation-gate'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  folderWorkspaceActivationBlocked,
  getFolderWorkspacePathStatusDescription,
  getFolderWorkspacePathStatusTitle
} from './folder-workspace-path-status'
import { toast } from 'sonner'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  findFolderWorkspaceOwner,
  getRuntimeEnvironmentIdForFolderWorkspace
} from './folder-workspace-runtime-owner'
import { getFolderWorkspaceHostId } from '../../../shared/folder-workspace-execution-host'
import type { WorktreeStartupPayload } from './worktree-startup-payload'
import {
  ensureFolderWorkspaceInitialTerminal,
  ensureWorktreeHasInitialTerminal
} from './worktree-initial-terminal-seeding'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from './web-runtime-worktree-terminal-after-wake'
import {
  activationProvidesInitialSurface,
  activationSeedsUserDefaultSurface,
  type WorktreeActivationSurfaceSelection
} from './worktree-activation-surface-selection'
import { gateAndReseedEmptyWorkspace } from './worktree-activation-gated-empty-reseed'
import { markVisited, readPreviousActive } from './worktree-activation-visit'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import type { ActivateAndRevealResult } from './worktree-activation'

export function activateAndRevealFolderWorkspace(
  folderWorkspaceId: string,
  opts?: WorktreeActivationSurfaceSelection & {
    sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
    revealInSidebar?: boolean
    showWorkspaceList?: boolean
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
  const folderWorkspace = selectFolderWorkspaces(state).find(
    (workspace) => workspace === folderWorkspaceOwner
  )
  if (!folderWorkspace) {
    return false
  }
  const runtimeEnvironmentId =
    opts && 'runtimeEnvironmentId' in opts
      ? (opts.runtimeEnvironmentId ?? null)
      : getRuntimeEnvironmentIdForFolderWorkspace(state, folderWorkspaceId, opts?.executionHostId)
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

  const navigation =
    opts?.navigation === undefined ? beginDesktopNavigation(state) : opts.navigation
  if (navigation === null || !canPresentDesktopNavigation(navigation)) {
    return {
      primaryTabId: opts?.startup
        ? ensureWorktreeHasInitialTerminal(
            state,
            folderWorkspaceKey(folderWorkspaceId),
            opts.startup,
            undefined,
            undefined,
            undefined,
            { activateCreatedTabs: false }
          )
        : null
    }
  }

  if (state.activeView !== 'terminal') {
    presentDesktopWorkspace(state, navigation)
  }

  const previousActive = readPreviousActive(state)
  state.setActiveFolderWorkspace(folderWorkspaceId, opts?.executionHostId)

  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const providesInitialSurface = activationProvidesInitialSurface(opts)
  const seedUserDefaultSurface = activationSeedsUserDefaultSurface(opts)
  markVisited(state, workspaceKey, previousActive, opts?.executionHostId, opts?.navigationIntent)
  if (!state.isNavigatingHistory) {
    state.recordWorktreeVisit(workspaceKey)
  }
  // Why: same ordering as the worktree path — gate first, then resume only when not deferring.
  const shouldGateAgentActivation =
    !opts?.startup &&
    (workspaceHasSleepingAgentSessions(state, workspaceKey) ||
      (canInspectAgentActivationInventory() &&
        shouldAutoCreateInitialTerminal(
          state.reconcileWorktreeTabModel(workspaceKey).renderableTabCount
        )))
  if (!shouldGateAgentActivation) {
    resumeSleepingAgentSessionsForWorktree(workspaceKey)
  }
  if (shouldGateAgentActivation) {
    gateAndReseedEmptyWorkspace(workspaceKey, {
      callerProvidesSurface: opts?.providesInitialSurface === true,
      seedUserDefaultSurface,
      navigation,
      ...(opts?.executionHostId ? { executionHostId: opts.executionHostId } : {})
    })
  }
  const primaryTabId = shouldGateAgentActivation
    ? null
    : ensureFolderWorkspaceInitialTerminal(
        folderWorkspace,
        opts?.startup,
        providesInitialSurface,
        seedUserDefaultSurface,
        navigation
      )

  if (opts?.showWorkspaceList) {
    state.setSidebarBody('workspaces')
  }
  if (opts?.revealInSidebar !== false) {
    state.revealWorktreeInSidebar(workspaceKey, {
      executionHostId:
        opts?.executionHostId ?? getFolderWorkspaceHostId(folderWorkspace, state.projectGroups),
      ...(opts?.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {})
    })
  }

  if (opts?.providesInitialSurface !== true) {
    ensureWebRuntimeWorktreeTerminalAfterWake(workspaceKey, {
      runtimeEnvironmentId,
      startup: opts?.startup,
      agent: opts?.agent
    })
  }

  if (opts?.navigationIntent === 'user-open') {
    openDesktopWorkbench(useAppStore.getState(), workspaceKey, navigation ?? undefined)
  }
  return { primaryTabId }
}
