/** What one twin owns, read back out of a host-twin fixture's store and module stores. */
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from './types'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { forgetWorktreeSleepIntent, hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import {
  clearHugeRepoWarningDismissalsForTests,
  hasDismissedHugeRepoWarning
} from '@/lib/source-control-huge-repo-warning-dismissals'
import type { HostTwinFixture, HostTwinSide } from './host-twin.test-fixture'

export function resetHostTwinModuleStores(fixture: HostTwinFixture): void {
  forgetWorktreeSleepIntent(fixture.workspaceKey)
  clearHugeRepoWarningDismissalsForTests()
  for (const s of [fixture.local, fixture.remote]) {
    updateNativeChatComposerDraft(s.paneKey, { text: '' }, 'deferred')
  }
}

function pick<T>(
  record: Record<string, T> | undefined,
  keys: readonly string[]
): Record<string, T> {
  return Object.fromEntries(
    keys.flatMap((key) => (record && key in record ? [[key, record[key]] as const] : []))
  )
}

/** Project owner-attributed plus unattributable shared state; acting on another twin must preserve both. */
export function projectHostTwinState(fixture: HostTwinFixture, owner: HostTwinSide) {
  const state: AppState = fixture.store.getState()
  const key = fixture.workspaceKey
  const tabIds = [owner.terminalTabId, fixture.dormantTabId]
  const ownedIds = new Set([...tabIds, owner.fileId])
  return {
    repos: (state.repos ?? []).filter((repo) => getRepoExecutionHostId(repo) === owner.hostId),
    worktrees: (state.worktreesByRepo[fixture.projectId] ?? []).filter(
      (worktree) => worktree.hostId === owner.hostId
    ),
    folderWorkspaces: (state.folderWorkspaces ?? []).filter(
      (folder) => folder.executionHostId === owner.hostId
    ),
    projectGroups: (state.projectGroups ?? []).filter(
      (group) => group.executionHostId === owner.hostId
    ),
    tabs: (state.tabsByWorktree[key] ?? []).filter((tab) => tabIds.includes(tab.id)),
    ptyIds: pick(state.ptyIdsByTabId, tabIds),
    layouts: pick(state.terminalLayoutsByTabId, tabIds),
    unifiedTabs: (state.unifiedTabsByWorktree[key] ?? []).filter((tab) => ownedIds.has(tab.id)),
    openFiles: state.openFiles.filter((file) => file.id === owner.fileId),
    editorDrafts: pick(state.editorDrafts, [owner.fileId]),
    sleepingAgentSessions: pick(state.sleepingAgentSessionsByPaneKey, [owner.paneKey]),
    moduleStores: snapshotHostTwinModuleStores(fixture, owner)
  }
}

/** Manually include module stores in buildWorktreePurgeState forgetters, outside Zustand. */
const HOST_TWIN_MODULE_STORES: readonly {
  name: string
  read: (fixture: HostTwinFixture, owner: HostTwinSide) => unknown
}[] = [
  {
    name: 'worktree-sleep-intent',
    read: (fixture) => hasWorktreeSleepIntent(fixture.workspaceKey)
  },
  {
    name: 'huge-repo-warning-dismissal',
    read: (fixture) => hasDismissedHugeRepoWarning(fixture.hugeRepoWarningProbe)
  },
  {
    name: 'native-chat-composer-draft',
    read: (_fixture, owner) => readNativeChatComposerDraft(owner.paneKey).text
  }
]

function snapshotHostTwinModuleStores(
  fixture: HostTwinFixture,
  owner: HostTwinSide
): Record<string, unknown> {
  return Object.fromEntries(HOST_TWIN_MODULE_STORES.map((s) => [s.name, s.read(fixture, owner)]))
}

/** Which projected entries differ; compared by value, as persisted state would be. */
export function changedHostTwinState(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>
): string[] {
  return Object.keys(before).filter(
    (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])
  )
}
