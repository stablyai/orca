import { describe, expect, it } from 'vitest'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph/sync-key'
import { buildRuntimeMobileAgentStatusProjectionForTests } from './sync-runtime-graph/agent-status-projection'
import { makeAgentStatusEntry, makeState } from './sync-runtime-graph-test-harness'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'

// Isolate comparator inputs with one shared Partial<AppState>. makeState defaults allocate fresh collections; separate defaults would make unrelated reference changes mask the intended field. Share every reference-compared map/array while activeTabId compares by value.
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
  it('includes assistant preview provenance in the mobile status projection', () => {
    const paneKey = 'term-1:11111111-1111-4111-8111-111111111111'
    const base = makeAgentStatusEntry({ paneKey, lastAssistantMessage: 'tool output' })
    const flagged = makeAgentStatusEntry({
      paneKey,
      lastAssistantMessage: 'tool output',
      lastAssistantMessageIsToolOutput: true
    })

    expect(buildRuntimeMobileAgentStatusProjectionForTests({ [paneKey]: base })).not.toBe(
      buildRuntimeMobileAgentStatusProjectionForTests({ [paneKey]: flagged })
    )
  })

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

  // Old JSON map keys cost ~750ms per click with accumulated tabs; unchanged map references now compare in constant time (agent-working-pane-typing-lag.md).
  it('reports equal when underlying state is reference-stable', () => {
    // Use distinct state objects sharing every inspected map; same-object input would let deep-equality regressions pass trivially.
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

    // No-op store writes retain relevant references; comparator must skip sync despite distinct state wrappers.
    expect(
      runtimeMobileSessionSyncKeysEqual(
        getRuntimeMobileSessionSyncKey(stateA),
        getRuntimeMobileSessionSyncKey(stateB)
      )
    ).toBe(true)
  })

  // Reference replacement must differ even with equal contents; deep equality silently restores large-map cost.
  it('reports not equal when reference-equal-by-content but reference-different maps are passed', () => {
    // Share every map except terminalLayoutsByTabId so incidental default churn cannot mask deep-equality regression.
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
    // Share all other comparator maps so only tabsByWorktree projection, not fresh defaults, drives inequality.
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
    // Gate skips key construction; draft-aware key tests cannot cover this path.
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
