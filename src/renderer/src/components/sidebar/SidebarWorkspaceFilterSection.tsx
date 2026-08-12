import React, { useMemo } from 'react'
import {
  CalendarClock,
  GitBranch,
  GitCommitHorizontal,
  MonitorSmartphone,
  Moon,
  SquareTerminal
} from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { FilterToggleRow } from './FilterToggleRow'
import {
  getPairedDeviceIdsByEnvironment,
  isFolderWorkspaceFromOtherDevice,
  isWorkspaceFromOtherDevice
} from './workspace-creator-visibility'

const SidebarWorkspaceFilterSection = React.memo(function SidebarWorkspaceFilterSection() {
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const hideAutomationGeneratedWorkspaces = useAppStore((s) => s.hideAutomationGeneratedWorkspaces)
  const setHideAutomationGeneratedWorkspaces = useAppStore(
    (s) => s.setHideAutomationGeneratedWorkspaces
  )
  const hideCliCreatedWorkspaces = useAppStore((s) => s.hideCliCreatedWorkspaces)
  const setHideCliCreatedWorkspaces = useAppStore((s) => s.setHideCliCreatedWorkspaces)
  const hideDetachedHeadWorkspaces = useAppStore((s) => s.hideDetachedHeadWorkspaces)
  const setHideDetachedHeadWorkspaces = useAppStore((s) => s.setHideDetachedHeadWorkspaces)
  const hideWorkspacesFromOtherDevices = useAppStore((s) => s.hideWorkspacesFromOtherDevices)
  const setHideWorkspacesFromOtherDevices = useAppStore((s) => s.setHideWorkspacesFromOtherDevices)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const alwaysShowDefaultBranchWorkspace = useAppStore((s) => s.alwaysShowDefaultBranchWorkspace)
  const setAlwaysShowDefaultBranchWorkspace = useAppStore(
    (s) => s.setAlwaysShowDefaultBranchWorkspace
  )
  const showOtherClientFilter = useMemo(() => {
    if (hideWorkspacesFromOtherDevices) {
      return true
    }
    const pairedDeviceIds = getPairedDeviceIdsByEnvironment(
      runtimeEnvironments,
      runtimeStatusByEnvironmentId
    )
    const worktrees = getIndexedAllWorktrees(worktreesByRepo)
    return (
      worktrees.some(
        (worktree) => !worktree.isArchived && isWorkspaceFromOtherDevice(worktree, pairedDeviceIds)
      ) ||
      folderWorkspaces.some((workspace) => {
        if (workspace.isArchived) {
          return false
        }
        return isFolderWorkspaceFromOtherDevice(workspace, pairedDeviceIds)
      })
    )
  }, [
    folderWorkspaces,
    hideWorkspacesFromOtherDevices,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    worktreesByRepo
  ])

  return (
    <>
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-semibold text-muted-foreground">
          {translate('auto.components.sidebar.SidebarWorkspaceFilterSection.82594419ba', 'Filters')}
        </span>
      </div>
      <FilterToggleRow
        icon={<Moon className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.SidebarWorkspaceFilterSection.ed1611b65b',
          'Hide sleeping'
        )}
        checked={!showSleepingWorkspaces}
        onChange={(hideSleeping) => setShowSleepingWorkspaces(!hideSleeping)}
      />
      {/* Why gated: the exemption only has an effect while sleeping workspaces
          are being swept, so it stays hidden until its parent row is on. */}
      {!showSleepingWorkspaces && (
        <FilterToggleRow
          indented
          icon={<GitBranch className="size-3.5" />}
          label={translate(
            'auto.components.sidebar.SidebarWorkspaceFilterSection.keepDefaultBranch',
            'Except default branch'
          )}
          ariaLabel={translate(
            'auto.components.sidebar.SidebarWorkspaceFilterSection.keepDefaultBranchAria',
            'Keep the default branch visible while hiding sleeping workspaces'
          )}
          checked={alwaysShowDefaultBranchWorkspace}
          onChange={setAlwaysShowDefaultBranchWorkspace}
        />
      )}
      <FilterToggleRow
        icon={<GitBranch className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.SidebarWorkspaceFilterSection.c3fa13dc2e',
          'Hide default branch'
        )}
        checked={hideDefaultBranchWorkspace}
        onChange={setHideDefaultBranchWorkspace}
      />
      <FilterToggleRow
        icon={<CalendarClock className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.SidebarWorkspaceFilterSection.automationCreated',
          'Hide automation-created'
        )}
        checked={hideAutomationGeneratedWorkspaces}
        onChange={setHideAutomationGeneratedWorkspaces}
      />
      <FilterToggleRow
        icon={<SquareTerminal className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.SidebarWorkspaceFilterSection.cliCreated',
          'Hide CLI-created'
        )}
        checked={hideCliCreatedWorkspaces}
        onChange={setHideCliCreatedWorkspaces}
      />
      {showOtherClientFilter && (
        <FilterToggleRow
          icon={<MonitorSmartphone className="size-3.5" />}
          label={translate(
            'auto.components.sidebar.SidebarWorkspaceFilterSection.otherClients',
            'Hide other-client workspaces'
          )}
          ariaLabel={translate(
            'auto.components.sidebar.SidebarWorkspaceFilterSection.otherClientsAria',
            'Hide workspaces created from other Orca clients on shared remote servers'
          )}
          checked={hideWorkspacesFromOtherDevices}
          onChange={setHideWorkspacesFromOtherDevices}
        />
      )}
      <FilterToggleRow
        icon={<GitCommitHorizontal className="size-3.5" />}
        label={translate(
          'auto.components.sidebar.SidebarWorkspaceFilterSection.detachedHead',
          'Hide detached HEAD'
        )}
        checked={hideDetachedHeadWorkspaces}
        onChange={setHideDetachedHeadWorkspaces}
      />
    </>
  )
})

export default SidebarWorkspaceFilterSection
