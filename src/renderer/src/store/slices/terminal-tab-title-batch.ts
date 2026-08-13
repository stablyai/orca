import { deriveGeneratedTabTitle } from '../../../../shared/agent-tab-title'
import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab, TerminalTab } from '../../../../shared/types'
import type { AppState } from '../types'

export type TerminalTabTitleUpdate = { tabId: string; title: string }

export type GeneratedTabTitleUpdate = {
  paneKey: string
  prompt: string
  options?: { replaceExistingGeneratedTitle?: boolean }
}

type TitleState = Pick<
  AppState,
  'activeWorktreeId' | 'settings' | 'sortEpoch' | 'tabsByWorktree' | 'unifiedTabsByWorktree'
>

type TitlePatch = Partial<Pick<AppState, 'sortEpoch' | 'tabsByWorktree' | 'unifiedTabsByWorktree'>>

type TitleUpdateResult = {
  patch: TitlePatch | null
  runtimeGraphChanged: boolean
}

type OwnerStage = {
  tabs: TerminalTab[]
  tabsChanged: boolean
  tabIndexesById: Map<string, number[]>
  unifiedTabs: Tab[]
  unifiedTabsChanged: boolean
  unifiedIndexByTabId: Map<string, number>
}

function getFallbackTabTitle(tab: TerminalTab): string {
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    tab.defaultTitle?.trim() ||
    tab.title ||
    'Terminal 1'
  )
}

function getTabIdFromPaneKey(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

function buildOwnerIndex(tabsByWorktree: TitleState['tabsByWorktree']): Map<string, string> {
  const ownerByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      ownerByTabId.set(tab.id, worktreeId)
    }
  }
  return ownerByTabId
}

function getOwnerStage(
  state: TitleState,
  stages: Map<string, OwnerStage>,
  worktreeId: string
): OwnerStage {
  const existing = stages.get(worktreeId)
  if (existing) {
    return existing
  }
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tabIndexesById = new Map<string, number[]>()
  for (let index = 0; index < tabs.length; index += 1) {
    const tabId = tabs[index].id
    const indexes = tabIndexesById.get(tabId)
    if (indexes) {
      indexes.push(index)
    } else {
      tabIndexesById.set(tabId, [index])
    }
  }
  const unifiedIndexByTabId = new Map<string, number>()
  for (let index = 0; index < unifiedTabs.length; index += 1) {
    const tab = unifiedTabs[index]
    if (tab.contentType === 'terminal' && !unifiedIndexByTabId.has(tab.entityId)) {
      unifiedIndexByTabId.set(tab.entityId, index)
    }
  }
  const stage: OwnerStage = {
    tabs,
    tabsChanged: false,
    tabIndexesById,
    unifiedTabs,
    unifiedTabsChanged: false,
    unifiedIndexByTabId
  }
  stages.set(worktreeId, stage)
  return stage
}

function updateStageTabs(
  stage: OwnerStage,
  indexes: readonly number[],
  update: (tab: TerminalTab) => TerminalTab
): void {
  if (!stage.tabsChanged) {
    stage.tabs = [...stage.tabs]
    stage.tabsChanged = true
  }
  for (const index of indexes) {
    stage.tabs[index] = update(stage.tabs[index])
  }
}

function updateStageUnifiedLabel(
  stage: OwnerStage,
  tabId: string,
  key: 'generatedLabel' | 'label',
  value: string
): void {
  const index = stage.unifiedIndexByTabId.get(tabId)
  if (index === undefined || stage.unifiedTabs[index]?.[key] === value) {
    return
  }
  if (!stage.unifiedTabsChanged) {
    stage.unifiedTabs = [...stage.unifiedTabs]
    stage.unifiedTabsChanged = true
  }
  stage.unifiedTabs[index] = { ...stage.unifiedTabs[index], [key]: value }
}

function finishTitleStages(
  state: TitleState,
  stages: Map<string, OwnerStage>,
  sortEpochIncrement = 0
): TitleUpdateResult {
  const tabsChanged = [...stages.values()].some((stage) => stage.tabsChanged)
  const unifiedTabsChanged = [...stages.values()].some((stage) => stage.unifiedTabsChanged)
  if (!tabsChanged && !unifiedTabsChanged) {
    return { patch: null, runtimeGraphChanged: false }
  }
  const patch: TitlePatch = {}
  if (tabsChanged) {
    patch.tabsByWorktree = { ...state.tabsByWorktree }
  }
  if (unifiedTabsChanged) {
    patch.unifiedTabsByWorktree = { ...state.unifiedTabsByWorktree }
  }
  for (const [worktreeId, stage] of stages) {
    if (stage.tabsChanged) {
      patch.tabsByWorktree![worktreeId] = stage.tabs
    }
    if (stage.unifiedTabsChanged) {
      patch.unifiedTabsByWorktree![worktreeId] = stage.unifiedTabs
    }
  }
  if (sortEpochIncrement > 0) {
    patch.sortEpoch = state.sortEpoch + sortEpochIncrement
  }
  return { patch, runtimeGraphChanged: tabsChanged }
}

export function applyTerminalTabTitleUpdates(
  state: TitleState,
  updates: readonly TerminalTabTitleUpdate[],
  ownerByTabId = buildOwnerIndex(state.tabsByWorktree)
): TitleUpdateResult {
  const stages = new Map<string, OwnerStage>()
  let sortEpochIncrement = 0
  for (const { tabId, title } of updates) {
    const ownerWorktreeId = ownerByTabId.get(tabId)
    if (!ownerWorktreeId) {
      continue
    }
    const stage = getOwnerStage(state, stages, ownerWorktreeId)
    const tabIndexes = stage.tabIndexesById.get(tabId)
    const currentTab = tabIndexes ? stage.tabs[tabIndexes[0]] : undefined
    if (!currentTab || !tabIndexes) {
      continue
    }
    const nextTitle = title.trim() || getFallbackTabTitle(currentTab)
    if (isDecorativeAgentTitleFrameChange(currentTab.title, nextTitle)) {
      updateStageUnifiedLabel(stage, tabId, 'label', currentTab.title)
      continue
    }
    updateStageUnifiedLabel(stage, tabId, 'label', nextTitle)
    if (currentTab.title === nextTitle) {
      continue
    }
    updateStageTabs(stage, tabIndexes, (tab) => ({
      ...tab,
      title: nextTitle,
      defaultTitle:
        tab.defaultTitle ??
        (/^Terminal \d+$/.test(tab.title) ? tab.title : undefined) ??
        (/^Terminal \d+$/.test(nextTitle) ? nextTitle : undefined)
    }))
    if (ownerWorktreeId !== state.activeWorktreeId) {
      sortEpochIncrement += 1
    }
  }
  return finishTitleStages(state, stages, sortEpochIncrement)
}

export function applyGeneratedTabTitleUpdates(
  state: TitleState,
  updates: readonly GeneratedTabTitleUpdate[],
  ownerByTabId = buildOwnerIndex(state.tabsByWorktree)
): TitleUpdateResult {
  if (state.settings?.tabAutoGenerateTitle !== true) {
    return { patch: null, runtimeGraphChanged: false }
  }
  const stages = new Map<string, OwnerStage>()
  for (const { paneKey, prompt, options } of updates) {
    const tabId = getTabIdFromPaneKey(paneKey)
    const ownerWorktreeId = tabId ? ownerByTabId.get(tabId) : undefined
    if (!tabId || !ownerWorktreeId || prompt.length === 0) {
      continue
    }
    const stage = getOwnerStage(state, stages, ownerWorktreeId)
    const tabIndexes = stage.tabIndexesById.get(tabId)
    const currentTab = tabIndexes ? stage.tabs[tabIndexes[0]] : undefined
    if (
      !currentTab ||
      !tabIndexes ||
      currentTab.customTitle?.trim() ||
      currentTab.quickCommandLabel?.trim()
    ) {
      continue
    }
    const existingGeneratedTitle = currentTab.generatedTitle?.trim()
    if (existingGeneratedTitle && options?.replaceExistingGeneratedTitle !== true) {
      continue
    }
    const generatedTitle = deriveGeneratedTabTitle(prompt)
    if (!generatedTitle || existingGeneratedTitle === generatedTitle) {
      continue
    }
    updateStageTabs(stage, tabIndexes, (tab) => ({ ...tab, generatedTitle }))
    updateStageUnifiedLabel(stage, tabId, 'generatedLabel', generatedTitle)
  }
  return finishTitleStages(state, stages)
}
