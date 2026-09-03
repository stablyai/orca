import type { UISlice, UISliceGet, UISliceSet } from './ui-slice-contract'
import {
  DEFAULT_AGENTS_GROUP_BY,
  DEFAULT_AGENTS_READ_FILTER
} from '../../../../../shared/agents-view-thread-filters'
import {
  DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
  DEFAULT_SHOW_SLEEPING_WORKSPACES,
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardModeUpdates,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties
} from '../../../../../shared/constants'
import {
  DEFAULT_USAGE_PERCENTAGE_DISPLAY,
  normalizeUsagePercentageDisplay
} from '../../../../../shared/usage-percentage-display'
import {
  DEFAULT_STATUS_BAR_USAGE_MODE,
  normalizeStatusBarUsageMode
} from '../../../../../shared/status-bar-usage-mode'
import type { WorkspaceHostScope } from '../../../../../shared/ui-chrome-types'
import {
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds
} from '../../../../../shared/execution-host'
import {
  ALL_AUTOMATION_HOSTS_FILTER,
  toPersistedAutomationHostFilter
} from '../../../../../shared/automation-host-filter'
import {
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  cloneDefaultWorkspaceStatuses,
  normalizeWorkspaceStatuses,
  WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT
} from '../../../../../shared/workspace-statuses'

export function createUiPreferenceActions(set: UISliceSet, get: UISliceGet): Partial<UISlice> {
  return {
    sidebarBody: 'workspaces',
    setSidebarBody: (body) => set({ sidebarBody: body }),

    groupBy: 'repo',
    // Why: group keys are mode-specific, so clear collapsed state on mode switch — stale keys are meaningless and accumulate.
    setGroupBy: (g) => {
      window.api.ui.set({ groupBy: g, collapsedGroups: [] }).catch(console.error)
      set({ groupBy: g, collapsedGroups: new Set<string>() })
    },

    sortBy: 'recent',
    setSortBy: (s) => set({ sortBy: s }),

    // Why: bare set — persists only via the debounced window.api.ui.set writer in App.tsx, not on its own.
    projectOrderBy: 'manual',
    setProjectOrderBy: (p) => set({ projectOrderBy: p }),

    showActiveOnly: false,
    setShowActiveOnly: (v) => set({ showActiveOnly: v }),

    showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
    setShowSleepingWorkspaces: (v) => set({ showSleepingWorkspaces: v }),

    workspaceHostScope: 'all',
    // Why: host scope is presentation/filtering only — must never trigger resource teardown (terminals, browser pages).
    setWorkspaceHostScope: (scope) => {
      const normalized = normalizeExecutionHostScope(scope)
      const visibleWorkspaceHostIds = normalized === 'all' ? null : [normalized]
      set({ workspaceHostScope: normalized, visibleWorkspaceHostIds })
      window.api.ui
        .set({ workspaceHostScope: normalized, visibleWorkspaceHostIds })
        .catch(console.error)
    },
    visibleWorkspaceHostIds: null,
    setVisibleWorkspaceHostIds: (ids) => {
      const normalized = normalizeVisibleExecutionHostIds(ids)
      // Why: workspaceHostScope stays the compat/default-host signal for creation flows; visibility can now be multi-select.
      let workspaceHostScope: WorkspaceHostScope = get().workspaceHostScope
      if (normalized === null) {
        workspaceHostScope = 'all'
      } else if (normalized.length === 1) {
        workspaceHostScope = normalized[0]
      }
      set({ visibleWorkspaceHostIds: normalized, workspaceHostScope })
      window.api.ui
        .set({ visibleWorkspaceHostIds: normalized, workspaceHostScope })
        .catch(console.error)
    },
    workspaceHostOrder: [],
    setWorkspaceHostOrder: (ids) => {
      const workspaceHostOrder = normalizeExecutionHostOrder(ids)
      set({ workspaceHostOrder })
      window.api.ui.set({ workspaceHostOrder }).catch(console.error)
    },
    automationHostFilter: ALL_AUTOMATION_HOSTS_FILTER,
    setAutomationHostFilter: (filter) => {
      window.api.ui
        .set({ automationHostFilter: toPersistedAutomationHostFilter(filter) })
        .catch(console.error)
      set({ automationHostFilter: filter })
    },
    manualRepoOrder: [],

    hideDefaultBranchWorkspace: false,
    setHideDefaultBranchWorkspace: (v) => set({ hideDefaultBranchWorkspace: v }),
    hideAutomationGeneratedWorkspaces: false,
    setHideAutomationGeneratedWorkspaces: (v) => set({ hideAutomationGeneratedWorkspaces: v }),
    hideCliCreatedWorkspaces: false,
    setHideCliCreatedWorkspaces: (v) => set({ hideCliCreatedWorkspaces: v }),
    hideDetachedHeadWorkspaces: false,
    setHideDetachedHeadWorkspaces: (v) => set({ hideDetachedHeadWorkspaces: v }),
    hideWorkspacesFromOtherDevices: false,
    setHideWorkspacesFromOtherDevices: (v) => set({ hideWorkspacesFromOtherDevices: v }),
    alwaysShowDefaultBranchWorkspace: true,
    setAlwaysShowDefaultBranchWorkspace: (v) => set({ alwaysShowDefaultBranchWorkspace: v }),

    showDotfilesByWorktree: {},
    setShowDotfilesForWorktree: (worktreeId, showDotfiles) =>
      set((s) => {
        if (!worktreeId) {
          return s
        }
        const current = s.showDotfilesByWorktree[worktreeId] ?? true
        if (current === showDotfiles) {
          return s
        }
        const next = { ...s.showDotfilesByWorktree }
        // Why: showing dotfiles is the default; only persist worktree-level opt-outs.
        if (showDotfiles) {
          delete next[worktreeId]
        } else {
          next[worktreeId] = false
        }
        return { showDotfilesByWorktree: next }
      }),
    toggleShowDotfilesForWorktree: (worktreeId) =>
      set((s) => {
        if (!worktreeId) {
          return s
        }
        const nextShowDotfiles = !(s.showDotfilesByWorktree[worktreeId] ?? true)
        const next = { ...s.showDotfilesByWorktree }
        if (nextShowDotfiles) {
          delete next[worktreeId]
        } else {
          next[worktreeId] = false
        }
        return { showDotfilesByWorktree: next }
      }),

    filterRepoIds: [],
    setFilterRepoIds: (ids) => set({ filterRepoIds: ids }),

    agentsVisibleHostIds: null,
    setAgentsVisibleHostIds: (ids) => {
      const agentsVisibleHostIds = normalizeVisibleExecutionHostIds(ids)
      set({ agentsVisibleHostIds })
      window.api.ui.set({ agentsVisibleHostIds }).catch(console.error)
    },
    agentsFilterRepoIds: [],
    setAgentsFilterRepoIds: (ids) => {
      set({ agentsFilterRepoIds: ids })
      window.api.ui.set({ agentsFilterRepoIds: [...ids] }).catch(console.error)
    },
    agentsShowChildAgents: false,
    setAgentsShowChildAgents: (v) => {
      set({ agentsShowChildAgents: v })
      window.api.ui.set({ agentsShowChildAgents: v }).catch(console.error)
    },
    agentsCompactMode: true,
    setAgentsCompactMode: (v) => {
      set({ agentsCompactMode: v })
      window.api.ui.set({ agentsCompactMode: v }).catch(console.error)
    },
    agentsReadFilter: DEFAULT_AGENTS_READ_FILTER,
    setAgentsReadFilter: (v) => {
      set({ agentsReadFilter: v })
      window.api.ui.set({ agentsReadFilter: v }).catch(console.error)
    },
    agentsGroupBy: DEFAULT_AGENTS_GROUP_BY,
    setAgentsGroupBy: (v) => {
      set({ agentsGroupBy: v })
      window.api.ui.set({ agentsGroupBy: v }).catch(console.error)
    },

    collapsedGroups: new Set<string>(),
    toggleCollapsedGroup: (key) =>
      set((s) => {
        const next = new Set(s.collapsedGroups)
        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }
        window.api.ui.set({ collapsedGroups: [...next] }).catch(console.error)
        return { collapsedGroups: next }
      }),

    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    _worktreeCardModeDefaulted: true,
    setWorktreeCardMode: (mode) => {
      const updates = getWorktreeCardModeUpdates(mode)
      set((s) => ({
        settings: s.settings ? { ...s.settings, ...updates.settings } : s.settings,
        worktreeCardProperties: updates.ui.worktreeCardProperties,
        _worktreeCardModeDefaulted: true
      }))
      void Promise.all([
        window.api.settings.set(updates.settings).then((nextSettings) => {
          if (nextSettings) {
            set({ settings: nextSettings })
          }
        }),
        window.api.ui.set(updates.ui)
      ]).catch(console.error)
    },
    setWorktreeCardProperties: (properties) => {
      const normalized = normalizeWorktreeCardProperties(properties)
      set({ worktreeCardProperties: normalized, _worktreeCardModeDefaulted: false })
      window.api.ui
        .set({ worktreeCardProperties: normalized, _worktreeCardModeDefaulted: false })
        .catch(console.error)
    },
    agentActivityDisplayMode: DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
    setAgentActivityDisplayMode: (mode) => {
      const normalized = normalizeAgentActivityDisplayMode(mode)
      window.api.ui.set({ agentActivityDisplayMode: normalized }).catch(console.error)
      set({ agentActivityDisplayMode: normalized })
    },

    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    setWorkspaceStatuses: (statuses) => {
      const normalized = normalizeWorkspaceStatuses(statuses)
      window.api.ui.set({ workspaceStatuses: normalized }).catch(console.error)
      set({ workspaceStatuses: normalized })
    },

    workspaceBoardOpacity: 1,
    setWorkspaceBoardOpacity: (opacity) => {
      const clamped = clampWorkspaceBoardOpacity(opacity)
      window.api.ui.set({ workspaceBoardOpacity: clamped }).catch(console.error)
      set({ workspaceBoardOpacity: clamped })
    },

    workspaceBoardColumnWidth: WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
    setWorkspaceBoardColumnWidth: (width) => {
      const clamped = clampWorkspaceBoardColumnWidth(width)
      window.api.ui.set({ workspaceBoardColumnWidth: clamped }).catch(console.error)
      set({ workspaceBoardColumnWidth: clamped })
    },

    syncTaskStatusFromWorkspaceBoard: false,
    setSyncTaskStatusFromWorkspaceBoard: (enabled) => {
      window.api.ui.set({ syncTaskStatusFromWorkspaceBoard: enabled }).catch(console.error)
      set({ syncTaskStatusFromWorkspaceBoard: enabled })
    },

    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    toggleStatusBarItem: (item) =>
      set((s) => {
        const current = s.statusBarItems || DEFAULT_STATUS_BAR_ITEMS
        const updated = current.includes(item)
          ? current.filter((i) => i !== item)
          : [...current, item]
        window.api.ui.set({ statusBarItems: updated }).catch(console.error)
        return { statusBarItems: updated }
      }),

    agentDashboardDrawerOpen: false,
    setAgentDashboardDrawerOpen: (open) => set({ agentDashboardDrawerOpen: open }),
    statusBarVisible: true,
    setStatusBarVisible: (v) => {
      window.api.ui.set({ statusBarVisible: v }).catch(console.error)
      set({ statusBarVisible: v })
    },
    usagePercentageDisplay: DEFAULT_USAGE_PERCENTAGE_DISPLAY,
    setUsagePercentageDisplay: (display) => {
      const normalized = normalizeUsagePercentageDisplay(display)
      // Why: changing the control is the discovery path, so permanently dismiss the one-time change notice.
      window.api.ui
        .set({
          usagePercentageDisplay: normalized,
          usagePercentageDisplayChangeNoticeDismissed: true
        })
        .catch(console.error)
      set({
        usagePercentageDisplay: normalized,
        usagePercentageDisplayChangeNoticeDismissed: true
      })
    },
    statusBarUsageMode: DEFAULT_STATUS_BAR_USAGE_MODE,
    setStatusBarUsageMode: (mode) => {
      const normalized = normalizeStatusBarUsageMode(mode)
      window.api.ui.set({ statusBarUsageMode: normalized }).catch(console.error)
      set({ statusBarUsageMode: normalized })
    }
  }
}
