import type { Tab } from './tab-types'
import { workerLeafIds, type WorkerTabStamp } from '../../orchestration/workers/worker-tab-stamp'
import { workerTabHasNewAgent } from '../../orchestration/workers/worker-tab-agent-identity'

export type WorkerTabsMode = 'open-when-clicked' | 'always-open'

/** Per-window strip choice; absent means automatic. */
export type WorkerTabStripChoice = 'kept' | 'hidden'

export type WorkerTabFoldContext = {
  mode: WorkerTabsMode
  peekTabId: string | null
  activeId: string | null
  choice: (tabId: string) => WorkerTabStripChoice | undefined
  /** Leaf ids of a terminal tab; undefined for non-terminal tabs. */
  leafIds: (tabId: string) => readonly string[] | undefined
  inGrace: (tabId: string) => boolean
  reachable: ReadonlySet<string>
  failOpenShown: ReadonlySet<string>
}

/** A stamped chat is the worker's only while the bound agent is the one the stamp names. */
export function isWorkerChatIdentityConsistent(
  tab: Pick<Tab, 'workerTab' | 'agentSessionAgent'>
): boolean {
  const stamp = tab.workerTab
  if (!stamp || workerTabHasNewAgent(stamp)) {
    return false
  }
  const stamped = stamp.agentIdentity?.agentType
  return !stamped || !tab.agentSessionAgent || stamped === tab.agentSessionAgent
}

/** Every leaf is Orca's worker leaf; any user leaf makes the tab mixed, and mixed tabs never fold. */
export function isWorkerTabFoldable(
  tab: Pick<Tab, 'workerTab' | 'contentType' | 'agentSessionAgent'>,
  leafIds: readonly string[] | undefined
): tab is Pick<Tab, 'contentType'> & { workerTab: WorkerTabStamp } {
  if (!tab.workerTab) {
    return false
  }
  if (tab.contentType === 'agent-session') {
    return isWorkerChatIdentityConsistent(tab)
  }
  if (tab.contentType !== 'terminal' || !leafIds || leafIds.length === 0) {
    return false
  }
  const owned = workerLeafIds(tab.workerTab)
  return leafIds.every((leafId) => owned.has(leafId))
}

/** A stamped tab holding at least one user leaf beside a worker leaf. */
export function isMixedWorkerTab(
  tab: Pick<Tab, 'workerTab' | 'contentType'>,
  leafIds: readonly string[] | undefined
): boolean {
  if (!tab.workerTab || tab.contentType !== 'terminal' || !leafIds) {
    return false
  }
  const owned = workerLeafIds(tab.workerTab)
  return leafIds.some((leafId) => owned.has(leafId)) && leafIds.some((leafId) => !owned.has(leafId))
}

/** Precedence: active > peek > mixed > kept > hidden (deliberate, wins over fail-open) > auto (reachable past grace). */
export function isWorkerTabFolded(
  tab: Pick<Tab, 'id' | 'workerTab' | 'contentType' | 'agentSessionAgent'>,
  ctx: WorkerTabFoldContext
): boolean {
  if (ctx.mode !== 'open-when-clicked') {
    return false
  }
  if (tab.id === ctx.activeId || tab.id === ctx.peekTabId) {
    return false
  }
  if (!isWorkerTabFoldable(tab, ctx.leafIds(tab.id))) {
    return false
  }
  const choice = ctx.choice(tab.id)
  if (choice === 'kept') {
    return false
  }
  if (choice === 'hidden') {
    return true
  }
  if (ctx.inGrace(tab.id)) {
    return true
  }
  return ctx.reachable.has(tab.id) && !ctx.failOpenShown.has(tab.id)
}

/** The tab to land on without ever reselecting a folded tab: most recent visible, else first visible, else none. */
export function pickVisibleLandingTabId(
  tabOrder: readonly string[],
  recentTabIds: readonly string[] | undefined,
  folded: ReadonlySet<string>,
  exclude?: string
): string | null {
  const present = new Set(tabOrder)
  const visible = (id: string): boolean => present.has(id) && !folded.has(id) && id !== exclude
  for (let index = (recentTabIds?.length ?? 0) - 1; index >= 0; index--) {
    const id = recentTabIds![index]!
    if (visible(id)) {
      return id
    }
  }
  return tabOrder.find(visible) ?? null
}

/** A worker leaf may join a tab only if that tab carries no other worker's stamp; one origin per tab. */
export function canMoveLeafIntoTab(
  source: Pick<Tab, 'workerTab'> | undefined,
  leafId: string,
  destination: Pick<Tab, 'workerTab'> | undefined
): boolean {
  const sourceStamp = source?.workerTab
  if (!sourceStamp || !workerLeafIds(sourceStamp).has(leafId)) {
    return true
  }
  const destinationStamp = destination?.workerTab
  if (!destinationStamp) {
    return true
  }
  return destinationStamp.origin.dispatchId === sourceStamp.origin.dispatchId
}

export const WORKER_TAB_CONFLICT_CODE = 'worker_tab_conflict'
