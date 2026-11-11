import { pickAdjacentLinkOpenGroupId } from '@/lib/links/placement/adjacent-link-open-group'
import { isEditorTabContentType } from './editor-tab-content-type'
import type { EditorTabContentType } from './editor-tab-content-type'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../../../shared/tab-types'

type AdjacentEditorOpenInput = {
  layout: TabGroupLayoutNode
  groups: readonly TabGroup[]
  tabs: readonly Tab[]
  sourceGroupId: string
  /** File identity already resolved by the open path; never re-derived from paths here. */
  fileId: string
  contentType: EditorTabContentType
}

/** Prefer an existing file view, then a neighboring editor or other neighbor, then the source. */
export function pickAdjacentEditorOpenGroupId(input: AdjacentEditorOpenInput): string | null {
  const groupsWithFile = new Set<string>()
  const tabsById = new Map<string, Tab>()
  for (const tab of input.tabs) {
    tabsById.set(tab.id, tab)
    if (tab.entityId === input.fileId && tab.contentType === input.contentType) {
      groupsWithFile.add(tab.groupId)
    }
  }
  const facts = new Map(
    input.groups.map((group) => {
      const activeTab = group.activeTabId ? tabsById.get(group.activeTabId) : undefined
      return [
        group.id,
        {
          hasMatchingDestination: groupsWithFile.has(group.id),
          showsDestinationSurface: activeTab ? isEditorTabContentType(activeTab.contentType) : false
        }
      ]
    })
  )
  return pickAdjacentLinkOpenGroupId({ ...input, facts })
}
