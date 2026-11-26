// "Reveal current" over the app's own state: the store, and the bot and group lists.
import { useCallback, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  readRuntimeStatuses,
  type RuntimeStatuses
} from '@/store/slices/runtime-status/views/runtime-status-owner'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import {
  getIndexedAllWorktrees,
  getIndexedWorktreeMap
} from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { selectFrontTab } from '@/store/slices/tabs/active-tab-selection'
import {
  readBotHostIds,
  readBotHostState,
  readBots,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import { readBotGroups, subscribeToBotGroupChanges } from '@/lib/bot-group-catalog-snapshot'
import { withKeptBotHomes } from '@/lib/bot-host-kept-homes'
import { getHostKeyedBotSidebarEntries } from '@/components/bots/bot-sidebar-entry-keys'
import { getKnownSidebarWorktreeById } from '@/components/sidebar/worktree-list/navigation/folder-reveal'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace/identity/workspace-scope'
import {
  buildBotWorkerOwners,
  resolveSidebarRevealTarget,
  resolveSidebarWorkspaceOwner,
  type BotWorkerOwnership,
  type SidebarRevealNoneReason,
  type SidebarRevealOwner,
  type SidebarRevealTarget,
  type SidebarWorkspaceOwner,
  type SidebarWorkspaceOwnerInputs
} from '../../../../shared/sidebar-list/sidebar-reveal-target'

type OwnerEntry = {
  kind: 'bot' | 'group'
  entryKey: string
  home: FolderWorkspace
  paused: boolean
  hostId: ExecutionHostId
}

const NO_WORKER_OWNERS: ReadonlyMap<string, BotWorkerOwnership> = new Map()

let lastEntries: { inputs: readonly unknown[]; entries: OwnerEntry[] } | null = null
let lastWorkerOwners: {
  inputs: readonly unknown[]
  owners: ReadonlyMap<string, BotWorkerOwnership>
} | null = null

function sameInputs(previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
  return previous !== undefined && next.every((input, index) => input === previous[index])
}

// Rebuilt only when the lists change, not on every store write.
function ownerEntries(
  bots: readonly Bot[],
  groups: readonly BotGroup[],
  folderWorkspaces: readonly FolderWorkspace[],
  hostIds: readonly ExecutionHostId[]
): OwnerEntry[] {
  const inputs = [bots, groups, folderWorkspaces, hostIds]
  if (lastEntries && sameInputs(lastEntries.inputs, inputs)) {
    return lastEntries.entries
  }
  const entries =
    bots.length === 0 && groups.length === 0
      ? []
      : getHostKeyedBotSidebarEntries(
          bots,
          groups,
          withKeptBotHomes(folderWorkspaces, hostIds)
        ).map((entry) => ({
          kind: entry.kind,
          entryKey: entry.id,
          home: entry.home,
          paused: entry.kind === 'bot' && entry.bot.paused,
          hostId: entry.kind === 'bot' ? entry.bot.hostId : entry.group.hostId
        }))
  lastEntries = { inputs, entries }
  return entries
}

// The sidebar's lineage is read only while a bot could list a worker: some bot, bots on, and
// Hide bot workspaces on (the Projects list's own rule, useBotListedWorktreeIdentities).
function workerOwners(
  state: AppState,
  statuses: RuntimeStatuses,
  entries: readonly OwnerEntry[],
  routed: boolean
): ReadonlyMap<string, BotWorkerOwnership> {
  if (!routed || !entries.some((entry) => entry.kind === 'bot')) {
    return NO_WORKER_OWNERS
  }
  const childrenByParent = selectSidebarChildrenByParentIdentity(state, statuses)
  const inputs = [entries, childrenByParent]
  if (lastWorkerOwners && sameInputs(lastWorkerOwners.inputs, inputs)) {
    return lastWorkerOwners.owners
  }
  const owners = buildBotWorkerOwners(
    entries.map((entry) => ({ ...entry, hidden: false, hostDown: false })),
    childrenByParent
  )
  lastWorkerOwners = { inputs, owners }
  return owners
}

function ownerInputs(
  state: AppState,
  statuses: RuntimeStatuses,
  bots: readonly Bot[],
  groups: readonly BotGroup[]
): SidebarWorkspaceOwnerInputs {
  const entries = ownerEntries(bots, groups, selectFolderWorkspaces(state) ?? [], readBotHostIds())
  const botsEnabled = state.settings?.botsEnabled !== false
  const hideBotCreatedWorkspaces = state.hideBotCreatedWorkspaces !== false
  const hidePausedBots = state.botSidebarView?.hidePausedBots === true
  const owners: SidebarRevealOwner[] = entries.map((entry) => ({
    kind: entry.kind,
    entryKey: entry.entryKey,
    home: entry.home,
    hidden: hidePausedBots && entry.paused,
    hostDown: readBotHostState(entry.hostId) === 'offline'
  }))
  return {
    botsEnabled,
    hideBotCreatedWorkspaces,
    owners,
    workerOwners: workerOwners(state, statuses, entries, botsEnabled && hideBotCreatedWorkspaces)
  }
}

function activeIsArchived(state: AppState, workspaceId: string): boolean {
  const worktreesByRepo = selectWorktreesByRepo(state)
  return (
    getKnownSidebarWorktreeById(
      workspaceId,
      getIndexedWorktreeMap(worktreesByRepo),
      selectFolderWorkspaces(state) ?? [],
      getIndexedAllWorktrees(worktreesByRepo),
      state.activeWorkspaceExecutionHostId
    )?.isArchived === true
  )
}

function targetFrom(
  state: AppState,
  statuses: RuntimeStatuses,
  bots: readonly Bot[],
  groups: readonly BotGroup[]
): SidebarRevealTarget {
  const activeWorkspaceId = getActiveSidebarWorkspaceId(
    state.activeWorkspaceKey,
    state.activeWorktreeId
  )
  return resolveSidebarRevealTarget({
    ...ownerInputs(state, statuses, bots, groups),
    activeView: state.activeView,
    activeWorkspaceId,
    activeHostId: state.activeWorkspaceExecutionHostId ?? null,
    frontTab: selectFrontTab(state),
    activeIsArchived: activeWorkspaceId ? activeIsArchived(state, activeWorkspaceId) : false
  })
}

/** What "Reveal current" points at right now, for a click or a command. */
export function readSidebarRevealTarget(): SidebarRevealTarget {
  return targetFrom(useAppStore.getState(), readRuntimeStatuses(), readBots(), readBotGroups())
}

/** Which section lists a workspace, for reveals that name one (activation, rename). */
export function readSidebarWorkspaceOwner(
  workspaceId: string,
  hostId: ExecutionHostId | null | undefined
): SidebarWorkspaceOwner {
  return resolveSidebarWorkspaceOwner(
    ownerInputs(useAppStore.getState(), readRuntimeStatuses(), readBots(), readBotGroups()),
    workspaceId,
    hostId ?? null
  )
}

function subscribeToBotLists(listener: () => void): () => void {
  const stopBots = subscribeToBotChanges(listener)
  const stopGroups = subscribeToBotGroupChanges(listener)
  return () => {
    stopBots()
    stopGroups()
  }
}

const readBotListsVersion = (): readonly [readonly Bot[], readonly BotGroup[]] => {
  const bots = readBots()
  const groups = readBotGroups()
  if (!lastLists || lastLists[0] !== bots || lastLists[1] !== groups) {
    lastLists = [bots, groups]
  }
  return lastLists
}
let lastLists: readonly [readonly Bot[], readonly BotGroup[]] | null = null

/** Why "Reveal current" has nothing to show, or null when it does. Reads the lists as already
 *  loaded; it never starts a bot read of its own. */
export function useSidebarRevealUnavailableReason(): SidebarRevealNoneReason | null {
  const [bots, groups] = useSyncExternalStore(
    subscribeToBotLists,
    readBotListsVersion,
    readBotListsVersion
  )
  const select = useCallback(
    (state: AppState, statuses: RuntimeStatuses): SidebarRevealNoneReason | null => {
      const target = targetFrom(state, statuses, bots, groups)
      return target.section === 'none' ? target.reason : null
    },
    [bots, groups]
  )
  return useAppStoreWithHostStatuses(select)
}
