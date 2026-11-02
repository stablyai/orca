import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { buildAgentPaneThreads } from './activity-thread-builder'
import {
  LEAF_ID,
  LEAF_ID_2,
  PANE_KEY,
  makeActivityResult,
  makeTab,
  makeWorkingEntryWithoutHistory
} from './ActivityPrototypePage-test-fixtures'

// Why: tab.title carries only the focused pane's title; here the focused pane is the sibling.
const SIBLING_FOCUSED_TAB = { ...makeTab(), title: '✳ Sibling task' }

const SPLIT_LAYOUT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: LEAF_ID },
    second: { type: 'leaf', leafId: LEAF_ID_2 }
  },
  activeLeafId: LEAF_ID_2,
  expandedLeafId: null
}

function threadTitle(args: {
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
}): string | undefined {
  const result = makeActivityResult({
    entries: { [PANE_KEY]: makeWorkingEntryWithoutHistory() },
    tab: SIBLING_FOCUSED_TAB
  })
  const threads = buildAgentPaneThreads({
    events: result.events,
    liveAgentByPaneKey: result.liveAgentByPaneKey,
    paneEntryByPaneKey: result.paneEntryByPaneKey,
    ...args
  })
  return threads.find((thread) => thread.paneKey === PANE_KEY)?.paneTitle
}

describe('buildAgentPaneThreads pane title in split tabs', () => {
  it('uses the row pane own session title, not the focused sibling tab title', () => {
    expect(
      threadTitle({
        terminalLayoutsByTabId: { 'tab-1': SPLIT_LAYOUT },
        runtimePaneTitlesByTabId: { 'tab-1': { 1: '✳ Own task', 2: '✳ Sibling task' } }
      })
    ).toBe('Own task')
  })

  it('falls back to the prompt when the row pane title cannot be resolved', () => {
    expect(
      threadTitle({
        terminalLayoutsByTabId: { 'tab-1': SPLIT_LAYOUT },
        runtimePaneTitlesByTabId: { 'tab-1': { 2: '✳ Sibling task' } }
      })
    ).toBe('New run')
  })

  it('keeps the tab title for a single-pane tab', () => {
    expect(threadTitle({})).toBe('Sibling task')
  })
})
