// Content facts of a tab this window asked main to open, in a layout-owner build: its tab-bar
// label and, for a browser tab, its page state and pages. Main holds only the tab's layout, so a
// frame build reads these as the store's own until the frame that draws the tab is in.

import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import {
  BROWSER_TAB_LAYOUT_FIELDS,
  BROWSER_TAB_WORKSPACE_FIELDS,
  type LayoutContentFacts
} from '../../../shared/workspace-layout/workspace-layout-beside'
import { omitStoredFields } from '../../../shared/workspace-layout/stored-record-fields'

export type PendingTabFacts = {
  worktreeId: string
  tabId: string
  label: string
  browser?: { record: BrowserWorkspace; pages: BrowserPage[] }
}

const pending = new Map<string, PendingTabFacts>()

/** Kept until the release, which is a no-op once a later expectation for the tab replaced it. */
export function expectTabFacts(facts: PendingTabFacts): () => void {
  pending.set(facts.tabId, facts)
  return () => {
    if (pending.get(facts.tabId) === facts) {
      pending.delete(facts.tabId)
    }
  }
}

/** `facts` with the pending tabs of `keys` added where the store had none of their own. */
export function withPendingTabFacts(
  facts: LayoutContentFacts,
  keys: readonly string[]
): LayoutContentFacts {
  const entries = [...pending.values()].filter((entry) => keys.includes(entry.worktreeId))
  if (entries.length === 0) {
    return facts
  }
  const tabLabels = { ...facts.tabLabels }
  const browserTabs = { ...facts.browserTabs }
  const browserPagesByWorkspace = { ...facts.browserPagesByWorkspace }
  for (const { worktreeId, tabId, label, browser } of entries) {
    if (tabLabels[worktreeId]?.[tabId] === undefined) {
      tabLabels[worktreeId] = { ...tabLabels[worktreeId], [tabId]: label }
    }
    if (!browser) {
      continue
    }
    const id = browser.record.id
    if (!browserTabs[worktreeId]?.[id]) {
      const live = omitStoredFields(browser.record, [
        ...BROWSER_TAB_LAYOUT_FIELDS,
        ...BROWSER_TAB_WORKSPACE_FIELDS
      ])
      browserTabs[worktreeId] = { ...browserTabs[worktreeId], [id]: { ...live, loading: false } }
    }
    if (!browserPagesByWorkspace[id]?.length) {
      browserPagesByWorkspace[id] = browser.pages.map((page) => ({ ...page, loading: false }))
    }
  }
  return { ...facts, tabLabels, browserTabs, browserPagesByWorkspace }
}

export function _resetPendingTabFactsForTests(): void {
  pending.clear()
}
