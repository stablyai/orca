// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import '../../sync-runtime-graph/mobile-session-snapshots'
import {
  focusRuntimeTerminalSurface,
  registerRuntimeTerminalTab
} from './mounted-terminal-tab-registry'
import '../../sync-runtime-graph-test-harness'

const TAB_ID = 'duplicate-tab'
const WORKTREE_A = 'registry-worktree-a'
const WORKTREE_B = 'registry-worktree-b'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('runtime terminal registration ownership', () => {
  it('focuses the requested worktree when tab ids collide', () => {
    const textareaA = document.createElement('textarea')
    const textareaB = document.createElement('textarea')
    document.body.append(textareaA, textareaB)
    const focusA = vi.fn(() => textareaA.focus())
    const focusB = vi.fn(() => textareaB.focus())
    const container = { querySelector: () => null }
    const paneA = {
      id: 1,
      leafId: LEAF_A,
      container,
      terminal: { focus: focusA, textarea: textareaA }
    }
    const paneB = {
      id: 1,
      leafId: LEAF_B,
      container,
      terminal: { focus: focusB, textarea: textareaB }
    }
    const managerA = {
      getPanes: () => [paneA],
      getActivePane: () => paneA,
      getLeafId: () => LEAF_A,
      getNumericIdForLeaf: () => 1
    }
    const managerB = {
      getPanes: () => [paneB],
      getActivePane: () => paneB,
      getLeafId: () => LEAF_B,
      getNumericIdForLeaf: () => 1
    }
    const unregisterA = registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WORKTREE_A,
      getManager: () => managerA as never,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    const unregisterB = registerRuntimeTerminalTab({
      tabId: TAB_ID,
      worktreeId: WORKTREE_B,
      getManager: () => managerB as never,
      getContainer: () => null,
      getPtyIdForPane: () => null,
      getTabWideAgentHintLeafId: () => null
    })
    try {
      expect(focusRuntimeTerminalSurface(TAB_ID, null, WORKTREE_B)).toBe(true)
      expect(document.activeElement).toBe(textareaB)
      expect(focusRuntimeTerminalSurface(TAB_ID)).toBe(false)
    } finally {
      textareaA.remove()
      textareaB.remove()
      unregisterB()
      unregisterA()
    }
  })
})
