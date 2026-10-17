import type { Tab } from '../../../shared/tab-types'

type PositionedTab = {
  position: number
  tab: Tab
}

export type WebSessionExistingTabIndex = {
  getTerminalContinuation: (tabId: string, hostTabId: string) => Tab | undefined
  getEditorUnifiedTab: (fileId: string, hostTabId: string) => Tab | null
  getEditorUnifiedTabByHostId: (hostTabId: string) => Tab | null
}

type BuildWebSessionExistingTabIndexArgs = {
  unifiedTabs: readonly Tab[]
  provisionalHandoffHostTabIds?: ReadonlyMap<string, string>
}

function setFirst<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key)) {
    map.set(key, value)
  }
}

export function buildWebSessionExistingTabIndex({
  unifiedTabs,
  provisionalHandoffHostTabIds
}: BuildWebSessionExistingTabIndexArgs): WebSessionExistingTabIndex {
  let indexes: {
    editorTabById: Map<string, PositionedTab>
    editorTabByFileId: Map<string, PositionedTab>
  } | null = null
  let terminalContinuations: {
    direct: Map<string, PositionedTab>
    handoff: Map<string, PositionedTab>
  } | null = null
  // Why: terminal-only snapshots are the common case, so a snapshot carrying no
  // mirrored editor tab never pays to walk the worktree's unified tab list.
  const getIndexes = (): NonNullable<typeof indexes> => {
    if (!indexes) {
      const editorTabById = new Map<string, PositionedTab>()
      const editorTabByFileId = new Map<string, PositionedTab>()
      unifiedTabs.forEach((tab, position) => {
        if (tab.contentType === 'editor') {
          const positioned = { position, tab }
          setFirst(editorTabById, tab.id, positioned)
          setFirst(editorTabByFileId, tab.entityId, positioned)
        }
      })
      indexes = { editorTabById, editorTabByFileId }
    }
    return indexes
  }

  return {
    getTerminalContinuation: (tabId, hostTabId) => {
      if (!terminalContinuations) {
        const direct = new Map<string, PositionedTab>()
        const handoffs = new Map<string, PositionedTab>()
        unifiedTabs.forEach((tab, position) => {
          const positioned = { tab, position }
          setFirst(direct, tab.id, positioned)
          const handoff = provisionalHandoffHostTabIds?.get(tab.id)
          if (handoff) {
            setFirst(handoffs, handoff, positioned)
          }
        })
        terminalContinuations = { direct, handoff: handoffs }
      }
      const direct = terminalContinuations.direct.get(tabId)
      const handoff = terminalContinuations.handoff.get(hostTabId)
      return direct && handoff
        ? direct.position <= handoff.position
          ? direct.tab
          : handoff.tab
        : (direct?.tab ?? handoff?.tab)
    },
    getEditorUnifiedTabByHostId: (hostTabId) =>
      getIndexes().editorTabById.get(hostTabId)?.tab ?? null,
    getEditorUnifiedTab: (fileId, hostTabId) => {
      const { editorTabById, editorTabByFileId } = getIndexes()
      const byHostId = editorTabById.get(hostTabId)
      const byFileId = editorTabByFileId.get(fileId)
      // Why: the former Array.find accepted either key, so duplicate legacy
      // entries must still resolve to whichever candidate appeared first.
      if (byHostId && byFileId) {
        return byHostId.position <= byFileId.position ? byHostId.tab : byFileId.tab
      }
      return byHostId?.tab ?? byFileId?.tab ?? null
    }
  }
}
