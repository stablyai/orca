import { beforeEach, describe, expect, it } from 'vitest'

import type { TerminalTab } from '../../../shared/terminal-tab-types'

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import '../../../shared/execution-host'
import '../../../shared/repo-kind'
import type { AppState } from './types'
import {
  resetFloatingVisibleTabCountSelectorCacheForTest,
  resetFloatingWorkspaceUnreadSelectorCacheForTest,
  selectFloatingVisibleTabCount,
  selectFloatingWorkspaceHasUnread
} from './selectors'
import './active-terminal-chrome-selector'

describe('store selectors', () => {
  beforeEach(() => {
    resetFloatingVisibleTabCountSelectorCacheForTest()
  })

  it('reuses the floating tab-count projection across unrelated store ticks', () => {
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    const terminalTabs = [
      {
        id: 'term-1',
        ptyId: null,
        worktreeId,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ] as AppState['tabsByWorktree'][string]
    const browserTabs = [{ id: 'browser-1' }] as AppState['browserTabsByWorktree'][string]
    let openFileScans = 0
    const fileEntries = [
      {
        id: 'file-1',
        filePath: '/tmp/file-1.ts',
        relativePath: 'file-1.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      },
      {
        id: 'file-2',
        filePath: '/tmp/file-2.ts',
        relativePath: 'file-2.ts',
        worktreeId: 'repo::/elsewhere',
        language: 'typescript',
        mode: 'edit',
        isDirty: false
      }
    ] as AppState['openFiles']
    const openFiles = [...fileEntries] as AppState['openFiles']
    Object.defineProperty(openFiles, Symbol.iterator, {
      value: function* () {
        openFileScans += 1
        for (const entry of fileEntries) {
          yield entry
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only each tab's contentType and entityId, which every fixture entry sets; the omitted Tab fields are never read.
    const unifiedTabs = [
      {
        id: 'unified-term-1',
        entityId: 'term-1',
        worktreeId,
        contentType: 'terminal',
        label: 'Terminal',
        sortOrder: 0,
        createdAt: 1
      },
      {
        id: 'unified-browser-1',
        entityId: 'browser-1',
        worktreeId,
        contentType: 'browser',
        label: 'Browser',
        sortOrder: 1,
        createdAt: 2
      },
      {
        id: 'unified-file-1',
        entityId: 'file-1',
        worktreeId,
        contentType: 'editor',
        label: 'file-1.ts',
        sortOrder: 2,
        createdAt: 3
      },
      {
        id: 'simulator-1',
        entityId: 'simulator-1',
        worktreeId,
        contentType: 'simulator',
        label: 'Mobile Emulator',
        sortOrder: 3,
        createdAt: 4
      },
      {
        // A structured chat is its own backing record, so it counts like a simulator.
        id: 'chat-1',
        entityId: 'session-1',
        worktreeId,
        contentType: 'agent-session',
        label: 'Claude Chat',
        sortOrder: 4,
        createdAt: 5
      },
      {
        id: 'unified-stale-terminal',
        entityId: 'missing-term',
        worktreeId,
        contentType: 'terminal',
        label: 'Stale',
        sortOrder: 4,
        createdAt: 5
      }
    ] as AppState['unifiedTabsByWorktree'][string]
    const state = {
      tabsByWorktree: { [worktreeId]: terminalTabs },
      browserTabsByWorktree: { [worktreeId]: browserTabs },
      openFiles,
      unifiedTabsByWorktree: { [worktreeId]: unifiedTabs }
    } satisfies Parameters<typeof selectFloatingVisibleTabCount>[0]

    expect(selectFloatingVisibleTabCount(state)).toBe(5)
    expect(openFileScans).toBe(1)

    expect(selectFloatingVisibleTabCount({ ...state })).toBe(5)
    expect(openFileScans).toBe(1)
  })
})

describe('selectFloatingWorkspaceHasUnread', () => {
  const FLOATING = FLOATING_TERMINAL_WORKTREE_ID

  type UnreadState = Parameters<typeof selectFloatingWorkspaceHasUnread>[0]

  beforeEach(() => {
    resetFloatingWorkspaceUnreadSelectorCacheForTest()
  })

  function makeState(overrides: Partial<UnreadState>): UnreadState {
    return {
      tabsByWorktree: {},
      unreadTerminalTabs: {},
      unreadAgentCompletionPanes: {},
      ...overrides
    } as UnreadState
  }

  it('shares one scan across consumers and skips 1,000 unrelated writes', () => {
    let tabIdReads = 0
    let terminalUnreadReads = 0
    let completionKeyScans = 0
    const tabs = [
      {
        get id() {
          tabIdReads += 1
          return 'ft1'
        },
        title: 'floating',
        ptyId: null
      } as unknown as TerminalTab
    ]
    const unreadTerminalTabs = new Proxy<Record<string, true>>(
      {},
      {
        get(target, property, receiver) {
          if (typeof property === 'string') {
            terminalUnreadReads += 1
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
          return Reflect.get(target, property, receiver)
        }
      }
    )
    const unreadAgentCompletionPanes = new Proxy<Record<string, true>>(
      { 'main-tab:leaf-a': true },
      {
        ownKeys(target) {
          completionKeyScans += 1
          return Reflect.ownKeys(target)
        }
      }
    )
    const state = makeState({
      tabsByWorktree: { [FLOATING]: tabs },
      unreadTerminalTabs,
      unreadAgentCompletionPanes
    })

    expect(selectFloatingWorkspaceHasUnread(state)).toBe(false)
    const countsAfterFirstConsumer = {
      tabIdReads,
      terminalUnreadReads,
      completionKeyScans
    }
    expect(selectFloatingWorkspaceHasUnread(state)).toBe(false)
    for (let write = 0; write < 1_000; write += 1) {
      expect(
        selectFloatingWorkspaceHasUnread({
          ...state,
          unrelatedStoreRevision: write
        } as unknown as UnreadState)
      ).toBe(false)
    }
    expect({ tabIdReads, terminalUnreadReads, completionKeyScans }).toEqual(
      countsAfterFirstConsumer
    )

    expect(
      selectFloatingWorkspaceHasUnread({
        ...state,
        unreadTerminalTabs: { ft1: true }
      })
    ).toBe(true)
    expect(tabIdReads).toBeGreaterThan(countsAfterFirstConsumer.tabIdReads)
  })
})
