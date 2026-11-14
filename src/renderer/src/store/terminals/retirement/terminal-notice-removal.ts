import {
  getTerminalNoticeLifetime,
  retireTerminalNoticeLifetime,
  type TerminalNoticeLifetime
} from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import {
  buildTerminalTabRetirementPlans,
  collectPtyIdsForTab,
  type TerminalTabRetirementPlan,
  type TerminalTabRetirementState
} from './terminal-tab-retirement'

function workspaceTerminalTabs(state: TerminalTabRetirementState, workspaceIds: readonly string[]) {
  const tabs = new Map<string, string | null>()
  for (const id of workspaceIds) {
    for (const tab of state.tabsByWorktree[id] ?? []) {
      tabs.set(tab.id, tab.ptyId)
    }
    for (const tab of state.unifiedTabsByWorktree[id] ?? []) {
      if (tab.contentType === 'terminal' && !tabs.has(tab.entityId)) {
        tabs.set(tab.entityId, null)
      }
    }
  }
  return tabs
}

function selectPlannedNotices(
  plans: Iterable<TerminalTabRetirementPlan>,
  notices: ReadonlyMap<string, TerminalNoticeLifetime>
): TerminalNoticeLifetime[] {
  const selected = new Set<TerminalNoticeLifetime>()
  for (const plan of plans) {
    for (const id of [
      ...plan.localOrSshPtyIds,
      ...plan.cleanupOnlyPtyIds,
      ...plan.unroutablePtyIds
    ]) {
      const notice = notices.get(id)
      if (notice) {
        selected.add(notice)
      }
    }
  }
  return [...selected]
}

export function retireRemovedWorktreeTerminalNotices(
  notices: readonly TerminalNoticeLifetime[]
): void {
  for (const notice of notices) {
    retireTerminalNoticeLifetime(notice)
  }
}

function captureWorkspaceNotices(
  before: TerminalTabRetirementState,
  workspaceIds: readonly string[]
) {
  const tabs = workspaceTerminalTabs(before, workspaceIds)
  const notices = new Map<string, TerminalNoticeLifetime>()
  for (const [tabId, rowId] of tabs) {
    for (const id of collectPtyIdsForTab(before, tabId, rowId)) {
      const notice = getTerminalNoticeLifetime(id)
      if (notice) {
        notices.set(id, notice)
      }
    }
  }
  return { tabs, notices }
}

/** Backend removal carries only selected objects across its asynchronous request. */
export function captureWorktreeTerminalNoticeRemoval(
  before: TerminalTabRetirementState,
  workspaceId: string
): readonly TerminalNoticeLifetime[] {
  const { tabs, notices } = captureWorkspaceNotices(before, [workspaceId])
  return notices.size === 0
    ? []
    : selectPlannedNotices(
        buildTerminalTabRetirementPlans(before, [...tabs.keys()]).values(),
        notices
      )
}

/** Capture before a removal erases bindings; only accepted final removal settles these objects. */
export function captureWorkspaceTerminalNoticeRemoval(
  before: TerminalTabRetirementState,
  workspaceIds: readonly string[]
): (after: TerminalTabRetirementState) => void {
  const { tabs, notices } = captureWorkspaceNotices(before, workspaceIds)
  return (after) => {
    if (notices.size === 0) {
      return
    }
    const remaining = new Set<string>()
    for (const bucket of Object.values(after.tabsByWorktree)) {
      for (const tab of bucket) {
        remaining.add(tab.id)
      }
    }
    for (const bucket of Object.values(after.unifiedTabsByWorktree)) {
      for (const tab of bucket) {
        if (tab.contentType === 'terminal') {
          remaining.add(tab.entityId)
        }
      }
    }
    const doomed = [...tabs.keys()].filter((id) => !remaining.has(id))
    if (doomed.length > 0) {
      retireRemovedWorktreeTerminalNotices(
        selectPlannedNotices(buildTerminalTabRetirementPlans(before, doomed).values(), notices)
      )
    }
  }
}
