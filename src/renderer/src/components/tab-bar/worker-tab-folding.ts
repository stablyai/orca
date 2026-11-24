import {
  workerRowMembershipInputsUnchanged,
  captureWorkerRowMembership,
  type WorkerRowMembershipSnapshot
} from './worker-tab-reachability-inputs'
import { workerTabExecutionHost, forgetWorkerTabExecutionHost } from './worker-tab-execution-host'
import { workerTabGraceEndsAt, workerTabFeeds } from './worker-tab-feed-grace'
export { RESTORED_WORKER_GRACE_MS, NEW_WORKER_GRACE_MS } from './worker-tab-feed-grace'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '@/store/types'
import { workerTabLeafIds } from './worker-tab-leaves'
import {
  isWorkerTabFolded,
  type WorkerTabFoldContext
} from '../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'
import { selectReachableWorkerTabIds, forgetWorkerTabReachability } from './worker-tab-reachability'
export {
  selectReachableWorkerTabIds,
  selectReachableWorkerPaneKeys
} from './worker-tab-reachability'

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_TABS: readonly Tab[] = []
const hasWorkersCache = new WeakMap<readonly Tab[], boolean>()

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false
    }
  }
  return true
}

export function isWorkerTabInGrace(
  state: AppState,
  tab: Pick<Tab, 'createdAt'>,
  now: number,
  worktreeId = ''
): boolean {
  const hostId = workerTabExecutionHost(state, worktreeId) ?? 'local'
  return workerTabGraceEndsAt(hostId, tab.createdAt, now) !== null
}

type FoldEvaluation = {
  folded: ReadonlySet<string>
  /** Stamped automatic tabs shown because nothing leads back to them; recorded as sticky by the strip. */
  failOpen: readonly string[]
  /** When the earliest grace window in this pane ends, so the strip can re-evaluate then. */
  nextGraceEndsAt: number | null
}

const EMPTY_EVALUATION: FoldEvaluation = { folded: EMPTY_SET, failOpen: [], nextGraceEndsAt: null }

type FoldMemo = {
  mode: AppState['workerTabsMode']
  graceEpoch: AppState['workerTabGraceEpoch']
  layouts: AppState['terminalLayoutsByTabId']
  membership: WorkerRowMembershipSnapshot
  hostId: string
  tabs: readonly Tab[]
  active: string | null | undefined
  peek: string | undefined
  choices: unknown
  failOpen: unknown
  feedSeen: unknown
  reachable: ReadonlySet<string>
  roots: ReadonlyMap<string, unknown>
  result: FoldEvaluation
}
type Groups = NonNullable<AppState['groupsByWorktree'][string]>
const foldMemo = new Map<string, WeakMap<Groups, Map<string, FoldMemo>>>()

function groupMemos(state: AppState, worktreeId: string): Map<string, FoldMemo> | undefined {
  const groups = state.groupsByWorktree[worktreeId]
  return groups ? foldMemo.get(worktreeId)?.get(groups) : undefined
}

export function selectWorkerTabFold(
  state: AppState,
  worktreeId: string,
  groupId: string
): FoldEvaluation {
  const previous = groupMemos(state, worktreeId)?.get(groupId)
  if (
    previous &&
    previous.mode === state.workerTabsMode &&
    previous.peek === state.workerTabPeekByGroupId[groupId] &&
    previous.choices === state.workerTabStripChoiceByWorktree[worktreeId] &&
    previous.failOpen === state.workerTabFailOpenShown &&
    previous.graceEpoch === state.workerTabGraceEpoch &&
    previous.feedSeen === workerTabFeeds(previous.hostId) &&
    workerRowMembershipInputsUnchanged(previous.membership, state)
  ) {
    return previous.result
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS
  let hasWorkers = hasWorkersCache.get(tabs)
  if (hasWorkers === undefined) {
    hasWorkers = tabs.some((tab) => Boolean(tab.workerTab))
    hasWorkersCache.set(tabs, hasWorkers)
  }
  if (state.workerTabsMode === 'always-open' || !hasWorkers) {
    groupMemos(state, worktreeId)?.delete(groupId)
    if (!hasWorkers) {
      forgetWorkerTabReachability(worktreeId)
    }
    return EMPTY_EVALUATION
  }
  let group
  const groups = state.groupsByWorktree[worktreeId]
  for (let index = 0; groups && index < groups.length; index++) {
    const candidate = groups[index]!
    if (candidate.id === groupId) {
      group = candidate
      break
    }
  }
  const reachable = selectReachableWorkerTabIds(state, worktreeId)
  const hostId = workerTabExecutionHost(state, worktreeId) ?? 'local'
  const feed = workerTabFeeds(hostId)
  const choices = state.workerTabStripChoiceByWorktree[worktreeId]
  const peek = state.workerTabPeekByGroupId[groupId]
  const workspaceMemo = groupMemos(state, worktreeId)
  const memo = workspaceMemo?.get(groupId)
  let rootsMatch = true
  if (memo && memo.layouts !== state.terminalLayoutsByTabId) {
    for (const tab of tabs) {
      if (
        tab.workerTab &&
        tab.groupId === groupId &&
        memo.roots.get(tab.id) !== state.terminalLayoutsByTabId[tab.entityId]?.root
      ) {
        rootsMatch = false
        break
      }
    }
  }
  if (
    memo &&
    memo.tabs === tabs &&
    memo.active === group?.activeTabId &&
    memo.peek === peek &&
    memo.choices === choices &&
    memo.failOpen === state.workerTabFailOpenShown &&
    memo.graceEpoch === state.workerTabGraceEpoch &&
    memo.feedSeen === feed &&
    memo.reachable === reachable &&
    rootsMatch
  ) {
    memo.mode = state.workerTabsMode
    memo.graceEpoch = state.workerTabGraceEpoch
    memo.layouts = state.terminalLayoutsByTabId
    memo.membership = captureWorkerRowMembership(state)
    return memo.result
  }
  return buildWorkerTabFold(state, worktreeId, groupId, tabs, reachable)
}

function buildWorkerTabFold(
  state: AppState,
  worktreeId: string,
  groupId: string,
  tabs: readonly Tab[],
  reachable: ReadonlySet<string>
): FoldEvaluation {
  let workspaceMemo = groupMemos(state, worktreeId)
  const memo = workspaceMemo?.get(groupId)
  const choices = state.workerTabStripChoiceByWorktree[worktreeId]
  const peek = state.workerTabPeekByGroupId[groupId]
  const hostId = workerTabExecutionHost(state, worktreeId) ?? 'local'
  const feed = workerTabFeeds(hostId)
  const group = state.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)
  const now = Date.now()
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const ctx: WorkerTabFoldContext = {
    mode: state.workerTabsMode,
    peekTabId: state.workerTabPeekByGroupId[groupId] ?? null,
    activeId: group?.activeTabId ?? null,
    choice: (tabId) => choices?.[tabId],
    leafIds: (tabId) => {
      const tab = tabById.get(tabId)
      return tab ? workerTabLeafIds(state, tab) : undefined
    },
    inGrace: (tabId) => {
      const tab = tabById.get(tabId)
      return tab ? isWorkerTabInGrace(state, tab, now, worktreeId) : false
    },
    reachable,
    failOpenShown: new Set(Object.keys(state.workerTabFailOpenShown))
  }
  const folded = new Set<string>()
  const failOpen: string[] = []
  let nextGraceEndsAt: number | null = null
  for (const tab of tabs) {
    if (tab.groupId !== groupId || !tab.workerTab) {
      continue
    }
    if (isWorkerTabFolded(tab, ctx)) {
      folded.add(tab.id)
      if (ctx.inGrace(tab.id)) {
        const endsAt = workerTabGraceEndsAt(hostId, tab.createdAt, now)!
        nextGraceEndsAt = nextGraceEndsAt === null ? endsAt : Math.min(nextGraceEndsAt, endsAt)
      }
    } else if (
      !choices?.[tab.id] &&
      !reachable.has(tab.id) &&
      !state.workerTabFailOpenShown[tab.id] &&
      tab.id !== ctx.activeId &&
      tab.id !== ctx.peekTabId &&
      !ctx.inGrace(tab.id)
    ) {
      failOpen.push(tab.id)
    }
  }
  const previous = memo?.result
  const result: FoldEvaluation = {
    folded: previous && sameMembers(previous.folded, folded) ? previous.folded : folded,
    failOpen,
    nextGraceEndsAt
  }
  const roots = new Map<string, unknown>()
  for (const tab of tabs) {
    if (tab.workerTab && tab.groupId === groupId) {
      roots.set(tab.id, state.terminalLayoutsByTabId[tab.entityId]?.root)
    }
  }
  if (!workspaceMemo) {
    const groups = state.groupsByWorktree[worktreeId]
    if (!groups) {
      return result
    }
    let generations = foldMemo.get(worktreeId)
    if (!generations) {
      generations = new WeakMap()
      foldMemo.set(worktreeId, generations)
    }
    workspaceMemo = new Map()
    generations.set(groups, workspaceMemo)
  }
  workspaceMemo.set(groupId, {
    mode: state.workerTabsMode,
    graceEpoch: state.workerTabGraceEpoch,
    layouts: state.terminalLayoutsByTabId,
    membership: captureWorkerRowMembership(state),
    hostId,
    tabs,
    active: group?.activeTabId,
    peek,
    choices,
    failOpen: state.workerTabFailOpenShown,
    feedSeen: feed,
    reachable,
    roots,
    result
  })
  return result
}

export function selectFoldedWorkerTabIds(
  state: AppState,
  worktreeId: string,
  groupId: string
): ReadonlySet<string> {
  return selectWorkerTabFold(state, worktreeId, groupId).folded
}

export function withoutFoldedWorkerTabs(
  state: AppState,
  worktreeId: string,
  groupId: string,
  tabOrder: string[]
): string[] {
  const folded = selectFoldedWorkerTabIds(state, worktreeId, groupId)
  return folded.size === 0 ? tabOrder : tabOrder.filter((id) => !folded.has(id))
}

export function foldedWorkerTerminalIds(state: AppState, worktreeId: string): ReadonlySet<string> {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS
  let out: Set<string> | null = null
  for (const group of groups) {
    const folded = selectFoldedWorkerTabIds(state, worktreeId, group.id)
    for (const tab of tabs) {
      if (tab.contentType === 'terminal' && folded.has(tab.id)) {
        out ??= new Set()
        out.add(tab.entityId)
      }
    }
  }
  return out ?? EMPTY_SET
}

export function forgetWorkerTabFolding(worktreeId: string): void {
  forgetWorkerTabExecutionHost(worktreeId)
  forgetWorkerTabReachability(worktreeId)
  foldMemo.delete(worktreeId)
}
