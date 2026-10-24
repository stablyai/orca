import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../../shared/terminal-tab-types'
import { resolveTerminalTabTitle } from '../../../../../shared/tab-title-resolution'
import { collectLeafIds } from '../../../../../shared/terminal-pane-layout-tree'
import { resolveRuntimePaneTitleForLeaf } from '../../../../../shared/runtime-pane-title-leaf-id'
import type { OpenFile } from '@/store/slices/editor'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'

export type SidebarTabPane = {
  leafId: string
  title: string
  isActive: boolean
}

export type SidebarTabItem = {
  tab: Tab
  title: string
  isActive: boolean
  isDirty: boolean
  faviconUrl: string | null
  /** Two or more panes: rendered as one Arc-style split pill. */
  panes: SidebarTabPane[] | null
}

export type SidebarTabModelInput = {
  unifiedTabs: readonly Tab[]
  groups: readonly TabGroup[]
  activeGroupId: string | undefined
  terminalTabs: readonly TerminalTab[]
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string> | undefined>
  openFiles: readonly OpenFile[]
  browserWorkspaces: readonly BrowserWorkspace[]
  generatedTitlesEnabled: boolean
}

const EDITOR_CONTENT_TYPES = new Set<Tab['contentType']>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

export function isSidebarEditorTab(tab: Tab): boolean {
  return EDITOR_CONTENT_TYPES.has(tab.contentType)
}

// Group order, then each group's tabOrder: the same order the top tab strips show.
function orderTabs(unifiedTabs: readonly Tab[], groups: readonly TabGroup[]): Tab[] {
  const byId = new Map(unifiedTabs.map((tab) => [tab.id, tab]))
  const ordered: Tab[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const tabId of group.tabOrder) {
      const tab = byId.get(tabId)
      if (tab && !seen.has(tab.id)) {
        ordered.push(tab)
        seen.add(tab.id)
      }
    }
  }
  // Why: a tab missing from tabOrder (mid-reconcile) still deserves a row.
  for (const tab of [...unifiedTabs].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!seen.has(tab.id)) {
      ordered.push(tab)
    }
  }
  return ordered
}

function resolvePanes(
  input: SidebarTabModelInput,
  terminalTabId: string,
  isActiveTab: boolean
): SidebarTabPane[] | null {
  const layout = input.terminalLayoutsByTabId[terminalTabId]
  const leafIds = collectLeafIds(layout?.root)
  if (!layout || leafIds.length < 2) {
    return null
  }
  const runtimeTitles = input.runtimePaneTitlesByTabId[terminalTabId]
  return leafIds.map((leafId, index) => ({
    leafId,
    title:
      layout.titlesByLeafId?.[leafId] ||
      resolveRuntimePaneTitleForLeaf(layout, runtimeTitles, leafId) ||
      `Pane ${index + 1}`,
    isActive: isActiveTab && layout.activeLeafId === leafId
  }))
}

function resolveTitle(input: SidebarTabModelInput, tab: Tab): string {
  if (tab.customLabel) {
    return tab.customLabel
  }
  if (tab.contentType === 'terminal') {
    const terminalTab = input.terminalTabs.find((candidate) => candidate.id === tab.entityId)
    if (terminalTab) {
      return resolveTerminalTabTitle(terminalTab, input.generatedTitlesEnabled, terminalTab.title)
    }
  }
  if (isSidebarEditorTab(tab)) {
    const file = input.openFiles.find((candidate) => candidate.id === tab.entityId)
    if (file) {
      return getEditorDisplayLabel(file)
    }
  }
  if (tab.contentType === 'browser') {
    const workspace = input.browserWorkspaces.find((candidate) => candidate.id === tab.entityId)
    if (workspace?.title) {
      return workspace.title
    }
  }
  return tab.label || 'Untitled'
}

export function buildSidebarTabItems(input: SidebarTabModelInput): SidebarTabItem[] {
  const activeGroup = input.groups.find((group) => group.id === input.activeGroupId)
  return orderTabs(input.unifiedTabs, input.groups).map((tab) => {
    const isActive = activeGroup?.activeTabId === tab.id
    const file = isSidebarEditorTab(tab)
      ? input.openFiles.find((candidate) => candidate.id === tab.entityId)
      : undefined
    const browserWorkspace =
      tab.contentType === 'browser'
        ? input.browserWorkspaces.find((candidate) => candidate.id === tab.entityId)
        : undefined
    return {
      tab,
      title: resolveTitle(input, tab),
      isActive,
      isDirty: file?.isDirty === true,
      faviconUrl: browserWorkspace?.faviconUrl ?? null,
      panes: tab.contentType === 'terminal' ? resolvePanes(input, tab.entityId, isActive) : null
    }
  })
}
