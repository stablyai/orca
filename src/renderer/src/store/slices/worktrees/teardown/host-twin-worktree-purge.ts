import type { AppState } from '../../../types'
import { toSshExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import {
  collectRemovedHostTwinState,
  removedHostCanonicalizer,
  twinSelectionPatch
} from '../../../repos/repo-removal-host-twin-attribution'
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import { buildActiveSurfacePatch } from '../../tabs/tabs-surface'
import { collectSurfacePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { collectPtyIdsForTab } from '../../../terminals/terminal-tab-retirement'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { omitSleepingAgentSessionsForWorktrees } from './sleeping-agent-session-omission'
import {
  cancelStructuredLaunchesForWorktrees,
  retirePurgedTabLaunches
} from './purged-structured-launch-retirement'
import { buildWorktreePurgeSurfacePatch } from './worktree-purge-surface-patch'
import { noticeRemovedUnsavedFiles } from './removed-workspace-unsaved-files'

/**
 * Purges one host's attributable surfaces under ids a twin still publishes. Worktree-keyed
 * buckets, raw-id module stores and surfaces with no host evidence stay: they may be the twin's.
 */
export function buildHostTwinPurgeState(
  s: AppState,
  hostId: ExecutionHostId,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  changedPaneKeys?: Set<string>
): Partial<AppState> {
  const twinIds = new Set(twinHostIds.keys())
  const removed = collectRemovedHostTwinState(s, twinIds, hostId, twinHostIds)
  const canonical = (worktreeId: string) =>
    removedHostCanonicalizer(s, worktreeId, hostId, twinHostIds.get(worktreeId) ?? [])
  const cancelledSessionIds = cancelStructuredLaunchesForWorktrees(
    twinIds,
    (worktreeId, launchHostId) => canonical(worktreeId)(launchHostId) === hostId
  )
  const terminalTabs: { id: string; ptyId: string | null }[] = []
  for (const worktreeId of twinIds) {
    const legacyTabs = (s.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
      removed.terminalTabIds.has(tab.id)
    )
    terminalTabs.push(...legacyTabs)
    retirePurgedTabLaunches(
      s,
      worktreeId,
      legacyTabs,
      (s.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) => removed.otherTabIds.has(tab.id)),
      cancelledSessionIds
    )
  }
  // Why: a hydrated terminal can exist only as a unified tab, with no legacy row.
  for (const tabId of removed.terminalTabIds) {
    if (!terminalTabs.some((tab) => tab.id === tabId)) {
      terminalTabs.push({ id: tabId, ptyId: null })
    }
  }
  // Why: a preview keys its source's editor state, unless a surviving file still uses that source.
  const survivingFiles = s.openFiles.filter((file) => !removed.fileIds.has(file.id))
  const previewSourceIds = s.openFiles.flatMap((file) =>
    removed.fileIds.has(file.id) &&
    file.markdownPreviewSourceFileId &&
    !survivingFiles.some(
      (other) =>
        other.id === file.markdownPreviewSourceFileId ||
        other.markdownPreviewSourceFileId === file.markdownPreviewSourceFileId
    )
      ? [file.markdownPreviewSourceFileId]
      : []
  )
  const doomed = collectSurfacePurgeDoomedIds(s, {
    tabs: terminalTabs,
    browserWorkspaceIds: removed.browserTabIds,
    fileIds: [...removed.fileIds, ...previewSourceIds]
  })
  // Why: a PTY a kept tab still binds stays live, so its PTY-keyed state must stay with it.
  for (const worktreeId of twinIds) {
    for (const tab of s.tabsByWorktree[worktreeId] ?? []) {
      if (!doomed.doomedTabIds.has(tab.id)) {
        for (const ptyId of collectPtyIdsForTab(s, tab.id, tab.ptyId)) {
          doomed.doomedPtyIds.delete(ptyId)
        }
      }
    }
  }
  const editorBufferKeepRequest = noticeRemovedUnsavedFiles(s, doomed.removedFileIds)
  const omitters = createWorktreePurgeOmitters(s, new Set(), doomed)
  const tabPrefixedSleeping = {
    sleepingAgentSessionsByPaneKey: omitters.omitByPaneKeyTabPrefix(
      s.sleepingAgentSessionsByPaneKey
    ),
    agentLaunchConfigByPaneKey: omitters.omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey)
  }
  // Why SSH only: a record whose tab is gone names its host just by connection; null is ambiguous.
  const sshRecordPaneKeys = Object.entries(s.sleepingAgentSessionsByPaneKey ?? {}).flatMap(
    ([paneKey, record]) =>
      twinIds.has(record.worktreeId) &&
      record.connectionId &&
      canonical(record.worktreeId)(toSshExecutionHostId(record.connectionId)) === hostId
        ? [paneKey]
        : []
  )
  const layout = removeWorktreeLayout(s, {
    worktreeIds: new Set(),
    tabIds: doomed.doomedTabIds,
    activeFileCleared: s.activeFileId != null && removed.fileIds.has(s.activeFileId),
    kept: {
      worktreeIds: twinIds,
      terminalTabIds: removed.terminalTabIds,
      fileIds: removed.fileIds,
      browserTabIds: removed.browserTabIds,
      unifiedTabIds: removed.otherTabIds
    }
  })
  const active = s.activeWorktreeId && twinIds.has(s.activeWorktreeId) ? s.activeWorktreeId : null
  // Why only then: re-deriving an untouched selection could switch the visible surface.
  const selectionRemoved =
    active !== null &&
    ((s.activeTabId != null && removed.terminalTabIds.has(s.activeTabId)) ||
      (s.activeFileId != null && removed.fileIds.has(s.activeFileId)) ||
      (s.activeBrowserTabId != null && removed.browserTabIds.has(s.activeBrowserTabId)) ||
      (layout.groupsByWorktree[active] ?? []).some(
        (group, index) => group.activeTabId !== s.groupsByWorktree[active]?.[index]?.activeTabId
      ))
  return {
    editorBufferKeepRequest,
    ...layout,
    // Why: a group may now show a surviving tab of another kind, so selection is derived again.
    ...(selectionRemoved ? buildActiveSurfacePatch({ ...s, ...layout }, active) : {}),
    ...buildWorktreePurgeSurfacePatch(
      s,
      omitters,
      doomed.doomedTabIds,
      {
        ...tabPrefixedSleeping,
        ...omitSleepingAgentSessionsForWorktrees(tabPrefixedSleeping, new Set(), sshRecordPaneKeys)
      },
      changedPaneKeys
    ),
    ...twinSelectionPatch(s, twinHostIds, hostId)
  }
}
