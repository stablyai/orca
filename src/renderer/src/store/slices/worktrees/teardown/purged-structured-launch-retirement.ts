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

/** Which launches under one dropped workspace end. */
type WorkspaceLaunchRemoval = {
  /** A target named no host, so every host's launch ends. */
  anyHost: boolean
  /** Ordinary launches on any host; a host launch waits on its own host, so only `hosts` end it. */
  ordinaryOnAnyHost: boolean
  /** Hosts whose launches of either kind end, their aliases included. */
  hosts: Set<ExecutionHostId>
}

/** A whole removal's launch membership by workspace id, built once from its targets and
 *  publishers so each launch row answers with one keyed lookup. */
export type LaunchRemoval = Map<string, WorkspaceLaunchRemoval>

/** A purge's launch retirement: its membership, then each part's tab retirement once every
 *  part's cancellations are known. */
export type PurgedLaunchRetirement = {
  removal: LaunchRemoval
  retireTabs: ((cancelledSessionIds: ReadonlySet<string>) => void)[]
}

export function createPurgedLaunchRetirement(): PurgedLaunchRetirement {
  return { removal: new Map(), retireTabs: [] }
}

function workspaceRemoval(removal: LaunchRemoval, worktreeId: string): WorkspaceLaunchRemoval {
  let entry = removal.get(worktreeId)
  if (!entry) {
    entry = { anyHost: false, ordinaryOnAnyHost: false, hosts: new Set() }
    removal.set(worktreeId, entry)
  }
  return entry
}

/** Whole-workspace drops: with `launchHostId`, only that host's copy went, so only its launches
 *  end; otherwise a target naming a host ends ordinary launches anywhere but host launches only
 *  on that host, and one naming none ends every launch. */
export function addTargetLaunchRemoval(
  removal: LaunchRemoval,
  targets: readonly WorktreePurgeTarget[],
  launchHostId?: ExecutionHostId
): LaunchRemoval {
  for (const { id, hostId } of targets) {
    const entry = workspaceRemoval(removal, id)
    if (launchHostId) {
      entry.hosts.add(launchHostId)
    } else if (hostId) {
      entry.ordinaryOnAnyHost = true
      entry.hosts.add(hostId)
    } else {
      entry.anyHost = true
    }
  }
  return removal
}

/** One removed copy's launches under ids a twin still publishes: only these hosts' end. */
export function addHostLaunchRemoval(
  removal: LaunchRemoval,
  launchHostsById: ReadonlyMap<string, readonly ExecutionHostId[]>
): LaunchRemoval {
  for (const [worktreeId, hosts] of launchHostsById) {
    const entry = workspaceRemoval(removal, worktreeId)
    for (const hostId of hosts) {
      entry.hosts.add(hostId)
    }
  }
  return removal
}

/** Cancels provisional structured-chat launches the removal names. */
export function cancelStructuredLaunchesForWorktrees(removal: LaunchRemoval): Set<string> {
  return retirePurgedLaunches({ removal, retireTabs: [] })
}

/** Ends a whole purge's launches at once: one pass over live and saved launches for all its
 *  parts, then each part's tabs, with each changed journal saved once at the end. */
export function retirePurgedLaunches(retirement: PurgedLaunchRetirement): Set<string> {
  const cancelledSessionIds = new Set<string>()
  batchStructuredAgentLaunchRecordWrites(() => {
    cancelLaunchesIn(retirement.removal, cancelledSessionIds)
    for (const retireTabs of retirement.retireTabs) {
      retireTabs(cancelledSessionIds)
    }
  })
  return cancelledSessionIds
}

function launchDropped(
  removal: LaunchRemoval,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  hostLaunch: boolean
): boolean {
  const entry = removal.get(worktreeId)
  return (
    !!entry &&
    (entry.anyHost || (!hostLaunch && entry.ordinaryOnAnyHost) || entry.hosts.has(executionHostId))
  )
}

function cancelLaunchesIn(removal: LaunchRemoval, cancelledSessionIds: Set<string>): void {
  if (removal.size === 0) {
    return
  }
  for (const launch of structuredLaunchStates()) {
    const worktreeId = launch.intent.worktreeId
    if (
      launchDropped(
        removal,
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
      launchDropped(removal, worktreeId, record.executionHostId, hostLaunch)
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
