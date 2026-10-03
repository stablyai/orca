import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalTabRetirementState } from '@/store/slices/terminal-tab-retirement'
import { mintStablePaneId } from '@/lib/pane-manager/mint-stable-pane-id'
import {
  clearRemovedTabFontSizeOverrides,
  hydrateTerminalFontSizeOverride,
  resetTerminalFontSizeOverridesForTest,
  setTerminalFontSizeOverride
} from './terminal-font-size-overrides'

const LEAF_ID = mintStablePaneId()

function tab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId: 'wt',
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function stateWithTabs(tabs: TerminalTab[]): TerminalTabRetirementState {
  return {
    tabsByWorktree: { wt: tabs },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
}

function hydratedFontSize(): number | undefined {
  const fontSizes = new Map<number, number>()
  hydrateTerminalFontSizeOverride({ id: 1, leafId: LEAF_ID }, fontSizes)
  return fontSizes.get(1)
}

describe('clearRemovedTabFontSizeOverrides', () => {
  beforeEach(() => {
    resetTerminalFontSizeOverridesForTest()
    setTerminalFontSizeOverride(LEAF_ID, 16)
  })

  it('clears a PTY-backed pane override when its tab is closed', () => {
    clearRemovedTabFontSizeOverrides(
      stateWithTabs([tab('unrelated', 'pty-2')]),
      { tabId: 'closed', worktreeId: 'wt' },
      [{ leafId: LEAF_ID, ptyId: 'pty-1' }]
    )
    expect(hydratedFontSize()).toBeUndefined()
  })

  it('keeps the override when a replacement tab adopts the same PTY', () => {
    clearRemovedTabFontSizeOverrides(
      stateWithTabs([tab('replacement', 'pty-1')]),
      { tabId: 'closed', worktreeId: 'wt' },
      [{ leafId: LEAF_ID, ptyId: 'pty-1' }]
    )
    expect(hydratedFontSize()).toBe(16)
  })

  it('clears an ID-less pane override', () => {
    clearRemovedTabFontSizeOverrides(
      stateWithTabs([tab('unrelated', 'pty-2')]),
      { tabId: 'closed', worktreeId: 'wt' },
      [{ leafId: LEAF_ID, ptyId: null }]
    )
    expect(hydratedFontSize()).toBeUndefined()
  })
})
