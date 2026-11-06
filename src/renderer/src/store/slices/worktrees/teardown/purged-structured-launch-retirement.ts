import { markStructuredAgentSessionLaunchCancelledSilently } from '@/lib/agent-session/launch/structured-agent-session-launch-cancel'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { forgetStructuredSessionSelection } from '@/lib/structured-agent-session-selection-controller'
import { settleAgentLaunchPaneStart } from '@/lib/agent-launch-pane-start'
import {
  getStructuredAgentSessionLaunchOwner,
  shouldRetainStructuredAgentSessionLaunchTab,
  structuredLaunchStates
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { discardStructuredAgentSessionChatSends } from '@/lib/agent-session/launch/structured-agent-session-launch-prompt'
import { forgetUnlistedCreatedChat } from '@/lib/structured-agent-session-unlisted-created-chats'
import {
  batchStructuredAgentLaunchRecordWrites,
  readStructuredAgentLaunchRecords
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { clearWebSessionFocusIntentIfMatches } from '@/runtime/web-session-focus-intent'
import {
  structuredAgentSessionFocusOwner,
  structuredAgentSessionTargetForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { flushRetiredHostEdits } from './removed-workspace-unsaved-files'
import type { StructuredAgentLaunchPersistedRecord } from '@/lib/agent-session/launch/structured-agent-session-launch-record'

/** Settles launch waits and retires chat ownership for purged tabs of one workspace. */
export function retirePurgedTabLaunches(
  s: AppState,
  worktreeId: string,
  terminalTabs: readonly TerminalTab[],
  unifiedTabs: readonly Tab[],
  cancelledSessionIds: ReadonlySet<string>,
  /** Set when only this host's copy went: another host's launch under the id lives on. */
  launchHostId?: ExecutionHostId
): void {
  // A launch tab that never spawned has no spawn left to answer its prompt's wait.
  for (const tab of terminalTabs) {
    if (tab.agentLaunchPane) {
      settleAgentLaunchPaneStart(tab.id, tab.agentLaunchPane.leafId, null)
    }
  }
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'agent-session') {
      forgetUnlistedCreatedChat(worktreeId, tab.entityId)
      retireStructuredAgentSessionReadOwner(
        tab.entityId,
        structuredAgentSessionTargetForHost(tab.executionHostId),
        tab.executionHostId ?? ''
      )
      const target = structuredAgentSessionTargetForTab(s, tab)
      if (target) {
        forgetStructuredSessionSelection(tab.entityId, target)
        retireStructuredAgentSessionReadOwner(tab.entityId, target)
      }
    }
    // A retained launch here survived a reload, so its persisted record names its host.
    const owner =
      tab.contentType === 'agent-session' && !cancelledSessionIds.has(tab.entityId)
        ? getStructuredAgentSessionLaunchOwner(tab.entityId)
        : undefined
    const target = structuredAgentSessionTargetForHost(owner)
    if (
      owner &&
      target &&
      (!launchHostId || owner === launchHostId) &&
      shouldRetainStructuredAgentSessionLaunchTab(worktreeId, tab.entityId)
    ) {
      markStructuredAgentSessionLaunchCancelledSilently(worktreeId, tab.entityId, owner)
      discardStructuredAgentSessionChatSends(tab.entityId)
      clearWebSessionFocusIntentIfMatches(
        structuredAgentSessionFocusOwner(target),
        worktreeId,
        `agent-session:${tab.entityId}`
      )
    }
  }
}

/** Which hosts dropped each workspace id; `true` when a target named no host, so any host's did. */
type DroppedWorkspaces = ReadonlyMap<string, true | ReadonlySet<ExecutionHostId>>

function droppedWorkspaces(
  droppedBy: readonly WorktreePurgeTarget[] | undefined
): DroppedWorkspaces | undefined {
  if (!droppedBy) {
    return undefined
  }
  const dropped = new Map<string, true | Set<ExecutionHostId>>()
  for (const { id, hostId } of droppedBy) {
    const hosts = dropped.get(id)
    if (hosts === true) {
      continue
    }
    dropped.set(id, hostId ? (hosts ?? new Set<ExecutionHostId>()).add(hostId) : true)
  }
  return dropped
}

/** A host launch waits on its own host: another host dropping the same workspace id ends nothing. */
function hostLaunchDropped(
  dropped: DroppedWorkspaces | undefined,
  worktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  const hosts = dropped?.get(worktreeId)
  return !dropped || hosts === true || !!hosts?.has(executionHostId)
}

type OwnedByHost = (worktreeId: string, executionHostId: ExecutionHostId) => boolean

/** One part of a purge: the workspaces it drops, whose launches in them end, and its own tab
 *  retirement once every part's cancellations are known. */
export type PurgedLaunchScope = {
  worktreeIds: ReadonlySet<string>
  /** Only launches on this host end; absent, any host's. */
  ownedByHost?: OwnedByHost
  /** The host each id was dropped by, when the purge knows it. */
  droppedBy?: readonly WorktreePurgeTarget[]
  retireTabs?: (cancelledSessionIds: ReadonlySet<string>) => void
}

/** Cancels provisional structured-chat launches in these worktrees, on the given host only.
 *  `droppedBy` names the host each id was dropped by, when the purge knows it. */
export function cancelStructuredLaunchesForWorktrees(
  worktreeIdSet: ReadonlySet<string>,
  ownedByHost?: OwnedByHost,
  droppedBy?: readonly WorktreePurgeTarget[]
): Set<string> {
  return retirePurgedLaunchScopes([{ worktreeIds: worktreeIdSet, ownedByHost, droppedBy }])
}

/** Ends a whole purge's launches at once: one pass over live and saved launches for all its
 *  parts, then each part's tabs, with each changed journal saved once at the end. */
export function retirePurgedLaunchScopes(scopes: readonly PurgedLaunchScope[]): Set<string> {
  const cancelledSessionIds = new Set<string>()
  batchStructuredAgentLaunchRecordWrites(() => {
    cancelLaunchesIn(scopesByWorkspace(scopes), cancelledSessionIds)
    for (const scope of scopes) {
      scope.retireTabs?.(cancelledSessionIds)
    }
  })
  return cancelledSessionIds
}

type WorkspaceScope = { ownedByHost?: OwnedByHost; dropped?: DroppedWorkspaces }

function scopesByWorkspace(
  scopes: readonly PurgedLaunchScope[]
): ReadonlyMap<string, WorkspaceScope[]> {
  const byWorkspace = new Map<string, WorkspaceScope[]>()
  for (const scope of scopes) {
    const entry = { ownedByHost: scope.ownedByHost, dropped: droppedWorkspaces(scope.droppedBy) }
    for (const worktreeId of scope.worktreeIds) {
      const inWorkspace = byWorkspace.get(worktreeId)
      if (inWorkspace) {
        inWorkspace.push(entry)
      } else {
        byWorkspace.set(worktreeId, [entry])
      }
    }
  }
  return byWorkspace
}

function launchDropped(
  byWorkspace: ReadonlyMap<string, readonly WorkspaceScope[]>,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  hostLaunch: boolean
): boolean {
  return !!byWorkspace
    .get(worktreeId)
    ?.some(
      ({ ownedByHost, dropped }) =>
        (!ownedByHost || ownedByHost(worktreeId, executionHostId)) &&
        (!hostLaunch || hostLaunchDropped(dropped, worktreeId, executionHostId))
    )
}

function cancelLaunchesIn(
  byWorkspace: ReadonlyMap<string, readonly WorkspaceScope[]>,
  cancelledSessionIds: Set<string>
): void {
  if (byWorkspace.size === 0) {
    return
  }
  for (const launch of structuredLaunchStates()) {
    const worktreeId = launch.intent.worktreeId
    if (
      launchDropped(
        byWorkspace,
        worktreeId,
        launch.intent.executionHostId,
        !!launch.intent.hostLaunch
      ) &&
      shouldRetainStructuredAgentSessionLaunchTab(worktreeId, launch.intent.sessionId)
    ) {
      markStructuredAgentSessionLaunchCancelledSilently(
        worktreeId,
        launch.intent.sessionId,
        launch.intent.executionHostId
      )
      discardStructuredAgentSessionChatSends(launch.intent.sessionId)
      retireStructuredAgentSessionReadOwner(launch.intent.sessionId, launch.intent.target)
      clearWebSessionFocusIntentIfMatches(
        structuredAgentSessionFocusOwner(launch.intent.target),
        worktreeId,
        `agent-session:${launch.intent.sessionId}`
      )
      cancelledSessionIds.add(launch.intent.sessionId)
    }
  }
  // A resume that publishes on commit has no tab or in-memory launch yet; its saved record names
  // the workspace it will open in. So does a host launch whose chat never showed, on any host:
  // its own host's listing dropping the workspace is the only thing that ends it short of a Dismiss.
  for (const record of readStructuredAgentLaunchRecords()) {
    const worktreeId = record.surfaceAddress?.worktreeId
    const hostLaunch = record.hostLaunchOperationId !== undefined
    if (
      worktreeId &&
      (record.executionHostId === 'local' || hostLaunch) &&
      !cancelledSessionIds.has(record.sessionId) &&
      launchDropped(byWorkspace, worktreeId, record.executionHostId, hostLaunch)
    ) {
      markStructuredAgentSessionLaunchCancelledSilently(
        worktreeId,
        record.sessionId,
        record.executionHostId
      )
      discardStructuredAgentSessionChatSends(record.sessionId)
      cancelledSessionIds.add(record.sessionId)
    }
  }
}

/** Before a removed paired host's purge: delayed views commit text it may offer back, and its
 *  saved chat launches end with it, including those whose workspace this window never loaded, so
 *  no row outlives the host it waits on. */
export function settleRetiredHostInput(state: AppState, removed: ReadonlySet<string>): void {
  flushRetiredHostEdits(state, removed)
  const hostIds = new Set<ExecutionHostId>([...removed].map(toRuntimeExecutionHostId))
  retireSavedStructuredLaunches(
    readStructuredAgentLaunchRecords().filter((record) => hostIds.has(record.executionHostId))
  )
}

/** Ends these saved launches in one save of each journal: each row its address names. */
export function retireSavedStructuredLaunches(
  records: readonly StructuredAgentLaunchPersistedRecord[]
): void {
  batchStructuredAgentLaunchRecordWrites(() => {
    for (const record of records) {
      const worktreeId = record.surfaceAddress?.worktreeId
      if (worktreeId) {
        markStructuredAgentSessionLaunchCancelledSilently(
          worktreeId,
          record.sessionId,
          record.executionHostId
        )
        discardStructuredAgentSessionChatSends(record.sessionId)
      }
    }
  })
}
