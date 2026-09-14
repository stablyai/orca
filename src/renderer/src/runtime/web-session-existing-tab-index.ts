import type { Tab } from '../../../shared/tab-types'

type PositionedTab = {
  position: number
  tab: Tab
}

export type WebSessionExistingTabIndex = {
  getEditorUnifiedTab: (fileId: string, hostTabId: string) => Tab | null
}

type BuildWebSessionExistingTabIndexArgs = {
  unifiedTabs: readonly Tab[]
}

function setFirst<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key)) {
    map.set(key, value)
  }
}

export function buildWebSessionExistingTabIndex({
  unifiedTabs
}: BuildWebSessionExistingTabIndexArgs): WebSessionExistingTabIndex {
  let indexes: {
    editorTabById: Map<string, PositionedTab>
    editorTabByFileId: Map<string, PositionedTab>
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
