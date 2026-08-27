import { describe, expect, it } from 'vitest'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph'
import { makeAgentStatusEntry, makeState } from './sync-runtime-graph-test-harness'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'

// Why: the comparator at `runtimeMobileSessionSyncKeysEqual` checks
// `terminalLayoutsByTabId`, `runtimePaneTitlesByTabId`, `groupsByWorktree`,
// `activeGroupIdByWorktree`, `unifiedTabsByWorktree`, `tabBarOrderByWorktree`,
// `activeFileIdByWorktree`, `openFiles`, and `editorDrafts` by reference, and
// checks `activeTabId` by scalar equality. `makeState`'s defaults allocate
// fresh `{}`/`[]` for each collection, so two unrelated `makeState({...})`
// calls trivially diverge. Tests that want to isolate a single field must
// share every other reference-checked collection between the two states; this
// factory produces one `Partial<AppState>` whose fields can be spread into both
// `makeState` calls.
function makeSharedOverrides(): Partial<AppState> {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    openFiles: [],
    editorDrafts: {},
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0
  }
}

describe('getRuntimeMobileSessionSyncKey', () => {
  it('changes when mobile markdown tab state changes', () => {
    const base = makeState({
      openFiles: [
        {
          id: '/repo/README.md',
          filePath: '/repo/README.md',
          relativePath: 'README.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: false
        }
      ]
    })

    const cleanKey = getRuntimeMobileSessionSyncKey(base)
    const dirtyKey = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        openFiles: [{ ...base.openFiles[0]!, isDirty: true }],
        editorDrafts: { '/repo/README.md': '# draft' }
      })
    )
    const activatedKey = getRuntimeMobileSessionSyncKey(
      makeState({ ...base, activeFileId: '/repo/README.md' })
    )

    expect(runtimeMobileSessionSyncKeysEqual(cleanKey, dirtyKey)).toBe(false)
    expect(runtimeMobileSessionSyncKeysEqual(cleanKey, activatedKey)).toBe(false)
  })

  it('changes when legacy tab bar order changes', () => {
    const base = makeState({
      tabBarOrderByWorktree: { 'wt-1': ['term-1', '/repo/README.md'] }
    })

    const reordered = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        tabBarOrderByWorktree: { 'wt-1': ['/repo/README.md', 'term-1'] }
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(getRuntimeMobileSessionSyncKey(base), reordered)).toBe(
      false
    )
  })

  it('changes when generated terminal title metadata changes', () => {
    const shared = makeSharedOverrides()
    const base = makeState({
      ...shared,
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Codex working', customTitle: null, ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree']
    })
    const before = getRuntimeMobileSessionSyncKey(base)
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-1',
              title: 'Codex working',
              generatedTitle: 'Fix remote tabs',
              customTitle: null,
              ptyId: 'pty-1'
            }
          ]
        } as unknown as AppState['tabsByWorktree']
      }),
      base,
      before
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('changes when quick command terminal label metadata changes', () => {
    const shared = makeSharedOverrides()
    const base = makeState({
      ...shared,
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'pnpm test', customTitle: null, ptyId: 'pty-1' }]
      } as unknown as AppState['tabsByWorktree']
    })
    const before = getRuntimeMobileSessionSyncKey(base)
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'term-1',
              title: 'pnpm test',
              quickCommandLabel: 'Run tests',
              customTitle: null,
              ptyId: 'pty-1'
            }
          ]
        } as unknown as AppState['tabsByWorktree']
      }),
      base,
      before
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('changes when generated terminal titles are toggled', () => {
    const shared = makeSharedOverrides()
    const tabsByWorktree = {
      'wt-1': [
        {
          id: 'term-1',
          title: 'Codex working',
          generatedTitle: 'Fix remote tabs',
          customTitle: null,
          ptyId: 'pty-1'
        }
      ]
    } as unknown as AppState['tabsByWorktree']
    const base = makeState({
      ...shared,
      tabsByWorktree,
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: false }
    })
    const before = getRuntimeMobileSessionSyncKey(base)
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true }
      }),
      base,
      before
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('changes when terminal split-pane layout changes', () => {
    const base = makeState({
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null
        }
      }
    })

    const split = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        terminalLayoutsByTabId: {
          'term-1': {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: 'pane:1' },
              second: { type: 'leaf', leafId: 'pane:2' }
            },
            activeLeafId: 'pane:2',
            expandedLeafId: null
          }
        }
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(getRuntimeMobileSessionSyncKey(base), split)).toBe(
      false
    )
  })

  // Why: the old key was a JSON.stringify of `tabsByWorktree` /
  // `terminalLayoutsByTabId` / `runtimePaneTitlesByTabId`. In workspaces with
  // hundreds of accumulated tabs this took ~750ms per call and pinned the main
  // thread on every click that mutated `tabsByWorktree` (e.g. `setActivePane`
  // → `updateTabTitle`). The new key compares those large maps by reference,
  // so the equality check is constant-time when the underlying maps are
  // unchanged. See docs/agent-working-pane-typing-lag.md.
  it('reports equal when underlying state is reference-stable', () => {
    // Why: build two distinct AppState instances that share the same map
    // references. If we passed the same state object twice, every map would be
    // trivially reference-equal and the test would still pass against a
    // deep-equal comparator, defeating the purpose of pinning down the
    // by-reference contract. Share every map the comparator inspects by
    // reference — any unshared default `{}` from `makeState` would diverge.
    const sharedOverrides: Partial<AppState> = {
      ...makeSharedOverrides(),
      tabsByWorktree: {
        'wt-1': [{ id: 'term-1', title: 'Terminal 1', customTitle: null }]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf' as const, leafId: 'pane:1' },
          activeLeafId: 'pane:1',
          expandedLeafId: null
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      runtimePaneTitlesByTabId: {
        'term-1': { 1: 'pane title' }
      } as unknown as AppState['runtimePaneTitlesByTabId']
    }
    const stateA = makeState(sharedOverrides)
    const stateB = makeState(sharedOverrides)

    // Why: when the store transitions through a no-op mutation, every relevant
    // reference is unchanged. Two distinct states sharing the same map
    // references must report equal so the subscriber early-returns and never
    // schedules a sync.
    expect(
      runtimeMobileSessionSyncKeysEqual(
        getRuntimeMobileSessionSyncKey(stateA),
        getRuntimeMobileSessionSyncKey(stateB)
      )
    ).toBe(true)
  })

  // Why: pins down the by-reference invariant — a future "fix" that swaps `===`
  // for deep equality on the large maps would silently regress the perf
  // optimization (see docs/agent-working-pane-typing-lag.md) without breaking
  // any other test.
  it('reports not equal when reference-equal-by-content but reference-different maps are passed', () => {
    // Why: share every other comparator-relevant map by reference so that a
    // by-reference comparator returns `true` for them, isolating
    // `terminalLayoutsByTabId` as the ONLY differing field. Without this, the
    // assertion would still pass under a deep-equal regression because the
    // defaults from two `makeState({})` calls diverge by reference anyway.
    const sharedOverrides = makeSharedOverrides()
    const mapA = {
      'term-1': {
        root: { type: 'leaf' as const, leafId: 'pane:1' },
        activeLeafId: 'pane:1',
        expandedLeafId: null
      }
    } as unknown as AppState['terminalLayoutsByTabId']
    const mapB = { ...mapA } as AppState['terminalLayoutsByTabId']

    const stateA = makeState({ ...sharedOverrides, terminalLayoutsByTabId: mapA })
    const stateB = makeState({ ...sharedOverrides, terminalLayoutsByTabId: mapB })

    expect(
      runtimeMobileSessionSyncKeysEqual(
        getRuntimeMobileSessionSyncKey(stateA),
        getRuntimeMobileSessionSyncKey(stateB)
      )
    ).toBe(false)
  })

  it('changes when tabsByWorktree title shape changes even if other maps are reference-stable', () => {
    // Why: the test name promises "other maps are reference-stable", so we
    // share every comparator-checked map by reference between `before` and
    // `after`. Only `tabsByWorktree` content varies — proving that the
    // tabs-projection path drives inequality and not some incidental
    // reference churn from `makeState`'s defaults.
    const sharedOverrides = makeSharedOverrides()

    const before = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        tabsByWorktree: {
          'wt-1': [{ id: 'term-1', title: 'Terminal 1', customTitle: null }]
        } as unknown as AppState['tabsByWorktree']
      })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        tabsByWorktree: {
          'wt-1': [{ id: 'term-1', title: 'Terminal 1 (renamed)', customTitle: null }]
        } as unknown as AppState['tabsByWorktree']
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('changes when a terminal tab launch agent changes', () => {
    const sharedOverrides = makeSharedOverrides()

    const before = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        tabsByWorktree: {
          'wt-1': [{ id: 'term-1', title: 'Terminal 1', customTitle: null }]
        } as unknown as AppState['tabsByWorktree']
      })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        tabsByWorktree: {
          'wt-1': [{ id: 'term-1', title: 'Terminal 1', customTitle: null, launchAgent: 'codex' }]
        } as unknown as AppState['tabsByWorktree']
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('changes when a native-chat launch draft is seeded or cleared', () => {
    const sharedOverrides = makeSharedOverrides()
    const launchDraft = {
      tabId: 'term-1',
      agent: 'claude' as const,
      text: 'https://github.com/o/r/issues/12',
      createdAt: 1
    }

    const before = getRuntimeMobileSessionSyncKey(
      makeState({ ...sharedOverrides, nativeChatLaunchDraftByTabId: {} })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        nativeChatLaunchDraftByTabId: { 'term-1': launchDraft }
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('does not skip the App subscriber gate when a launch draft is seeded', () => {
    // The key is never even built when this gate skips, so the draft-aware key
    // case above cannot catch a regression here.
    const sharedOverrides = makeSharedOverrides()
    const before = makeState({ ...sharedOverrides, nativeChatLaunchDraftByTabId: {} })
    const after = makeState({
      ...sharedOverrides,
      nativeChatLaunchDraftByTabId: {
        'term-1': {
          tabId: 'term-1',
          agent: 'claude' as const,
          text: 'https://github.com/o/r/issues/12',
          createdAt: 1
        }
      }
    })

    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before)).toBe(false)
  })

  it('changes and does not skip when a folder workspace is removed', () => {
    const sharedOverrides = makeSharedOverrides()
    const folderWorkspace = {
      id: 'folder-1'
    } as AppState['folderWorkspaces'][number]
    const before = makeState({
      ...sharedOverrides,
      folderWorkspaces: [folderWorkspace]
    })
    const after = makeState({
      ...sharedOverrides,
      folderWorkspaces: []
    })

    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before)).toBe(false)
    expect(
      runtimeMobileSessionSyncKeysEqual(
        getRuntimeMobileSessionSyncKey(before),
        getRuntimeMobileSessionSyncKey(after)
      )
    ).toBe(false)
  })

  it('changes when explicit agent status epoch changes', () => {
    const sharedOverrides = makeSharedOverrides()
    const before = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: {},
        agentStatusEpoch: 0
      })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: {},
        agentStatusEpoch: 1
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('changes for same-state agent detail updates with the same epoch', () => {
    const sharedOverrides = makeSharedOverrides()
    const paneKey = 'term-1:11111111-1111-4111-8111-111111111111'
    const beforeAgentStatusByPaneKey = {
      [paneKey]: makeAgentStatusEntry({ paneKey, prompt: 'fix parity' })
    }
    const afterAgentStatusByPaneKey = {
      [paneKey]: makeAgentStatusEntry({ paneKey, prompt: 'continue parity' })
    }

    const before = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: beforeAgentStatusByPaneKey,
        agentStatusEpoch: 1
      })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: afterAgentStatusByPaneKey,
        agentStatusEpoch: 1
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('coalesces timestamp-only agent heartbeats inside the same freshness bucket', () => {
    const sharedOverrides = makeSharedOverrides()
    const paneKey = 'term-1:11111111-1111-4111-8111-111111111111'
    const before = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({ paneKey, updatedAt: 30_000_000 })
        },
        agentStatusEpoch: 1
      })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({ paneKey, updatedAt: 30_001_000 })
        },
        agentStatusEpoch: 1
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(true)
  })

  it('changes for timestamp-only agent heartbeats in a later freshness bucket', () => {
    const sharedOverrides = makeSharedOverrides()
    const paneKey = 'term-1:11111111-1111-4111-8111-111111111111'
    const before = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({ paneKey, updatedAt: 30_000_000 })
        },
        agentStatusEpoch: 1
      })
    )
    const after = getRuntimeMobileSessionSyncKey(
      makeState({
        ...sharedOverrides,
        agentStatusByPaneKey: {
          [paneKey]: makeAgentStatusEntry({ paneKey, updatedAt: 30_030_000 })
        },
        agentStatusEpoch: 1
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(before, after)).toBe(false)
  })

  it('does not skip the App subscriber gate for same-epoch agent detail updates', () => {
    const sharedOverrides = makeSharedOverrides()
    const paneKey = 'term-1:11111111-1111-4111-8111-111111111111'
    const before = makeState({
      ...sharedOverrides,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, prompt: 'fix parity' })
      },
      agentStatusEpoch: 1
    })
    const after = makeState({
      ...sharedOverrides,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, prompt: 'continue parity' })
      },
      agentStatusEpoch: 1
    })

    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before)).toBe(false)
  })

  it('skips the App subscriber gate when sync inputs keep the same references', () => {
    const sharedOverrides = makeSharedOverrides()
    const before = makeState(sharedOverrides)
    const after = makeState(sharedOverrides)

    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before)).toBe(true)
  })

  it('changes and does not skip when terminal theme settings change', () => {
    const sharedOverrides = makeSharedOverrides()
    const beforeSettings = {
      ...getDefaultSettings('/tmp'),
      theme: 'dark' as const,
      terminalColorOverrides: { foreground: '#eeeeee' }
    }
    const afterSettings = {
      ...beforeSettings,
      terminalColorOverrides: { foreground: '#111111' }
    }
    const before = makeState({ ...sharedOverrides, settings: beforeSettings })
    const beforeKey = getRuntimeMobileSessionSyncKey(before)
    const after = makeState({ ...sharedOverrides, settings: afterSettings })
    const afterKey = getRuntimeMobileSessionSyncKey(after, before, beforeKey)

    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before)).toBe(false)
    expect(runtimeMobileSessionSyncKeysEqual(beforeKey, afterKey)).toBe(false)
  })

  it('changes and does not skip when system terminal appearance changes', () => {
    const sharedOverrides = makeSharedOverrides()
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'system' as const,
      terminalUseSeparateLightTheme: true
    }
    const before = makeState({ ...sharedOverrides, settings })
    const beforeKey = getRuntimeMobileSessionSyncKey(before, undefined, undefined, false)
    const after = makeState({ ...sharedOverrides, settings })
    const afterKey = getRuntimeMobileSessionSyncKey(after, before, beforeKey, true)

    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before, true, false)).toBe(false)
    expect(beforeKey.systemPrefersDark).toBe(false)
    expect(afterKey.systemPrefersDark).toBe(true)
    expect(afterKey.terminalThemeProjection).not.toBe(beforeKey.terminalThemeProjection)
    expect(runtimeMobileSessionSyncKeysEqual(beforeKey, afterKey)).toBe(false)
  })
})
