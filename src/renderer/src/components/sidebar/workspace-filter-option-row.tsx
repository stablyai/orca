import type React from 'react'
import {
  CalendarClock,
  GitBranch,
  GitCommitHorizontal,
  MonitorSmartphone,
  Moon,
  SquareTerminal
} from 'lucide-react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import type { WorkspaceViewOptionKey } from '../../../../shared/workspace-view/workspace-view-options'
import { FilterToggleRow } from './FilterToggleRow'

export type WorkspaceFilterOptionKey = Extract<
  WorkspaceViewOptionKey,
  | 'hideSleepingWorkspaces'
  | 'alwaysShowDefaultBranchWorkspace'
  | 'hideDefaultBranchWorkspace'
  | 'hideAutomationGeneratedWorkspaces'
  | 'hideCliCreatedWorkspaces'
  | 'hideWorkspacesFromOtherDevices'
  | 'hideDetachedHeadWorkspaces'
>

type FilterRow = {
  icon: React.ReactNode
  label: () => string
  ariaLabel?: () => string
  indented?: boolean
  checked: (state: AppState) => boolean
  set: (next: boolean) => void
}

const FILTER_ROWS: Record<WorkspaceFilterOptionKey, FilterRow> = {
  hideSleepingWorkspaces: {
    icon: <Moon className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.ed1611b65b',
        'Hide sleeping'
      ),
    checked: (state) => !state.showSleepingWorkspaces,
    set: (hide) => useAppStore.getState().setShowSleepingWorkspaces(!hide)
  },
  alwaysShowDefaultBranchWorkspace: {
    icon: <GitBranch className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.keepDefaultBranch',
        'Except default branch'
      ),
    ariaLabel: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.keepDefaultBranchAria',
        'Keep the default branch visible while hiding sleeping workspaces'
      ),
    indented: true,
    checked: (state) => state.alwaysShowDefaultBranchWorkspace,
    set: (next) => useAppStore.getState().setAlwaysShowDefaultBranchWorkspace(next)
  },
  hideDefaultBranchWorkspace: {
    icon: <GitBranch className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.c3fa13dc2e',
        'Hide default branch'
      ),
    checked: (state) => state.hideDefaultBranchWorkspace,
    set: (next) => useAppStore.getState().setHideDefaultBranchWorkspace(next)
  },
  hideAutomationGeneratedWorkspaces: {
    icon: <CalendarClock className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.automationCreated',
        'Hide automation-created'
      ),
    checked: (state) => state.hideAutomationGeneratedWorkspaces,
    set: (next) => useAppStore.getState().setHideAutomationGeneratedWorkspaces(next)
  },
  hideCliCreatedWorkspaces: {
    icon: <SquareTerminal className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.cliCreated',
        'Hide CLI-created'
      ),
    checked: (state) => state.hideCliCreatedWorkspaces,
    set: (next) => useAppStore.getState().setHideCliCreatedWorkspaces(next)
  },
  hideWorkspacesFromOtherDevices: {
    icon: <MonitorSmartphone className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.otherClients',
        'Hide other-client workspaces'
      ),
    ariaLabel: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.otherClientsAria',
        'Hide workspaces created from other Orca clients on shared remote servers'
      ),
    checked: (state) => state.hideWorkspacesFromOtherDevices,
    set: (next) => useAppStore.getState().setHideWorkspacesFromOtherDevices(next)
  },
  hideDetachedHeadWorkspaces: {
    icon: <GitCommitHorizontal className="size-3.5" />,
    label: () =>
      translate(
        'auto.components.sidebar.SidebarWorkspaceFilterSection.detachedHead',
        'Hide detached HEAD'
      ),
    checked: (state) => state.hideDetachedHeadWorkspaces,
    set: (next) => useAppStore.getState().setHideDetachedHeadWorkspaces(next)
  }
}

export function WorkspaceFilterOptionRow({
  optionKey
}: {
  optionKey: WorkspaceFilterOptionKey
}): React.JSX.Element {
  const row = FILTER_ROWS[optionKey]
  const checked = useAppStore(row.checked)
  return (
    <FilterToggleRow
      icon={row.icon}
      label={row.label()}
      ariaLabel={row.ariaLabel?.()}
      indented={row.indented}
      checked={checked}
      onChange={row.set}
    />
  )
}
