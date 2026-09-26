import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { BrowserPage, BrowserWorkspace } from './browser-workspace-types'
import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceVisibleTabType } from './tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { PersistedOpenFile, WorkspaceSessionState } from './workspace-session-state-types'

export const CROSS_MACHINE_RECOVERY_APPLY_CHANNEL = 'crossMachineRecovery:apply'
export const CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL = 'crossMachineRecovery:applyReply'

/** One recovered workspace's session slices, already re-keyed to local ids and paths. */
export type RecoveryWorkspaceFragment = {
  worktreeId: string
  terminalTabs: TerminalTab[]
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  unifiedTabs: Tab[]
  tabGroups: TabGroup[]
  tabGroupLayout: TabGroupLayoutNode | null
  activeGroupId: string | null
  openFiles: PersistedOpenFile[]
  activeFileId: string | null
  browserWorkspaces: BrowserWorkspace[]
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  activeBrowserTabId: string | null
  activeTabType: WorkspaceVisibleTabType | null
  activeTabId: string | null
}

export type CrossMachineRecoveryApplyOp =
  | { kind: 'import'; fragment: RecoveryWorkspaceFragment; records: SleepingAgentSessionRecord[] }
  | { kind: 'merge-records'; records: SleepingAgentSessionRecord[] }
  | { kind: 'claim-record'; worktreeId: string; providerSessionId: string }
  | { kind: 'restore-record'; record: SleepingAgentSessionRecord }

export type CrossMachineRecoveryApplyOutcome =
  | { ok: true; claimed: SleepingAgentSessionRecord | null }
  | { ok: false; code: 'recovery_destination_not_empty' }

export type CrossMachineRecoveryApplyRequest = {
  requestId: string
  op: CrossMachineRecoveryApplyOp
}

export type CrossMachineRecoveryApplyReply =
  | { requestId: string; outcome: CrossMachineRecoveryApplyOutcome }
  | { requestId: string; error: string }

export function isCrossMachineRecoveryRecord(record: Pick<SleepingAgentSessionRecord, 'origin'>) {
  return record.origin === 'recovery'
}

export function worktreeHasSessionTabs(session: WorkspaceSessionState, worktreeId: string) {
  return (
    (session.tabsByWorktree[worktreeId]?.length ?? 0) > 0 ||
    (session.unifiedTabs?.[worktreeId]?.length ?? 0) > 0 ||
    (session.openFilesByWorktree?.[worktreeId]?.length ?? 0) > 0 ||
    (session.browserTabsByWorktree?.[worktreeId]?.length ?? 0) > 0
  )
}

export function findRecoveryRecord(
  records: Readonly<Record<string, SleepingAgentSessionRecord>> | undefined,
  worktreeId: string,
  providerSessionId: string
): SleepingAgentSessionRecord | null {
  for (const record of Object.values(records ?? {})) {
    if (
      isCrossMachineRecoveryRecord(record) &&
      record.worktreeId === worktreeId &&
      record.providerSession.id === providerSessionId
    ) {
      return record
    }
  }
  return null
}

function withRecords(
  session: WorkspaceSessionState,
  records: readonly SleepingAgentSessionRecord[]
): WorkspaceSessionState {
  const next = { ...session.sleepingAgentSessionsByPaneKey }
  for (const record of records) {
    next[record.paneKey] = record
  }
  return { ...session, sleepingAgentSessionsByPaneKey: next }
}

function withFragment(
  session: WorkspaceSessionState,
  fragment: RecoveryWorkspaceFragment
): WorkspaceSessionState {
  const id = fragment.worktreeId
  const tabGroupLayouts = { ...session.tabGroupLayouts }
  if (fragment.tabGroupLayout) {
    tabGroupLayouts[id] = fragment.tabGroupLayout
  }
  const activeGroupIdByWorktree = { ...session.activeGroupIdByWorktree }
  if (fragment.activeGroupId) {
    activeGroupIdByWorktree[id] = fragment.activeGroupId
  }
  const activeTabTypeByWorktree = { ...session.activeTabTypeByWorktree }
  if (fragment.activeTabType) {
    activeTabTypeByWorktree[id] = fragment.activeTabType
  }
  return {
    ...session,
    tabsByWorktree: { ...session.tabsByWorktree, [id]: fragment.terminalTabs },
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      ...fragment.terminalLayoutsByTabId
    },
    unifiedTabs: { ...session.unifiedTabs, [id]: fragment.unifiedTabs },
    tabGroups: { ...session.tabGroups, [id]: fragment.tabGroups },
    tabGroupLayouts,
    activeGroupIdByWorktree,
    openFilesByWorktree: { ...session.openFilesByWorktree, [id]: fragment.openFiles },
    activeFileIdByWorktree: { ...session.activeFileIdByWorktree, [id]: fragment.activeFileId },
    browserTabsByWorktree: { ...session.browserTabsByWorktree, [id]: fragment.browserWorkspaces },
    browserPagesByWorkspace: {
      ...session.browserPagesByWorkspace,
      ...fragment.browserPagesByWorkspace
    },
    activeBrowserTabIdByWorktree: {
      ...session.activeBrowserTabIdByWorktree,
      [id]: fragment.activeBrowserTabId
    },
    activeTabTypeByWorktree,
    activeTabIdByWorktree: { ...session.activeTabIdByWorktree, [id]: fragment.activeTabId },
    // Why: a recovered workspace must never also receive the default terminal tab on first open.
    defaultTerminalTabsAppliedByWorktreeId: {
      ...session.defaultTerminalTabsAppliedByWorktreeId,
      [id]: true
    }
  }
}

/** Pure session transition shared by the headless runtime writer and the renderer's apply. */
export function applyCrossMachineRecoveryOp(
  session: WorkspaceSessionState,
  op: CrossMachineRecoveryApplyOp
): { session: WorkspaceSessionState; outcome: CrossMachineRecoveryApplyOutcome } {
  switch (op.kind) {
    case 'import':
      if (worktreeHasSessionTabs(session, op.fragment.worktreeId)) {
        return { session, outcome: { ok: false, code: 'recovery_destination_not_empty' } }
      }
      return {
        session: withRecords(withFragment(session, op.fragment), op.records),
        outcome: { ok: true, claimed: null }
      }
    case 'merge-records': {
      const existing = session.sleepingAgentSessionsByPaneKey ?? {}
      const fresh = op.records.filter((record) => existing[record.paneKey] === undefined)
      return { session: withRecords(session, fresh), outcome: { ok: true, claimed: null } }
    }
    case 'claim-record': {
      const claimed = findRecoveryRecord(
        session.sleepingAgentSessionsByPaneKey,
        op.worktreeId,
        op.providerSessionId
      )
      if (!claimed) {
        return { session, outcome: { ok: true, claimed: null } }
      }
      const next = { ...session.sleepingAgentSessionsByPaneKey }
      delete next[claimed.paneKey]
      return {
        session: { ...session, sleepingAgentSessionsByPaneKey: next },
        outcome: { ok: true, claimed }
      }
    }
    case 'restore-record':
      return { session: withRecords(session, [op.record]), outcome: { ok: true, claimed: null } }
  }
}
