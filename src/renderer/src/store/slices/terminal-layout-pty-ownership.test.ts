import { useAppStore } from '@/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from './agent-pane-authority'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import type { PaneForegroundAgentEntry } from './pane-foreground-agent'
import * as foreground from './pane-foreground-agent'
import * as leaves from '../../../../shared/terminal-pane-layout-tree'
import { createTerminalForegroundPublication } from '@/components/terminal-pane/pty-connection/terminal-foreground-services'
import { whenCodexTerminalAppears } from '@/components/terminal-pane/codex-terminal-presence'

const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'

describe('setTabLayout PTY ownership', () => {
  beforeEach(() => {
    resetAgentPaneAuthorityAliasesForTests()
  })

  it('visits affected local leaves and pays only the standalone immutable copy at N and 10N', () => {
    for (const size of [10, 100]) {
      const store = createTestStore()
      const target = makePaneKey('tab-1', LEAF_1)
      const sibling = makePaneKey('tab-1', LEAF_2)
      const layout = {
        root: {
          type: 'split' as const,
          direction: 'vertical' as const,
          first: { type: 'leaf' as const, leafId: LEAF_1 },
          second: { type: 'leaf' as const, leafId: LEAF_2 }
        },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'old', [LEAF_2]: 'sibling' }
      }
      store.setState({ terminalLayoutsByTabId: { 'tab-1': layout } })
      const value = {
        agent: 'codex' as const,
        agentEvidence: 'process-admitted' as const,
        shellForeground: false
      }
      const entries: Record<string, PaneForegroundAgentEntry> = Object.fromEntries(
        Array.from({ length: size }, (_, i) => [makePaneKey(`foreign-${i}`, LEAF_1), value])
      )
      entries[target] = {
        ...value,
        context: {
          execution: {},
          ptyId: 'old',
          incarnationId: 'inc',
          worktreeId: 'wt',
          environmentId: null
        }
      }
      entries[sibling] = value
      let enumerations = 0,
        reads = 0
      const tracked = new Proxy(entries, {
        ownKeys(record) {
          enumerations++
          return Reflect.ownKeys(record)
        },
        get(record, key, receiver) {
          reads++
          return Reflect.get(record, key, receiver)
        }
      })
      store.setState({ paneForegroundAgentByPaneKey: tracked })
      store.getState().replaceTerminalLayoutPanePtyId('tab-1', LEAF_1, 'new')
      expect(enumerations).toBe(1)
      expect(reads).toBeLessThanOrEqual(size + 4)
      expect(store.getState().paneForegroundAgentByPaneKey[target]).toBeUndefined()
      expect(store.getState().paneForegroundAgentByPaneKey[sibling]).toBe(value)
      expect(store.getState().paneForegroundAgentByPaneKey[makePaneKey('foreign-0', LEAF_1)]).toBe(
        value
      )
      const before = store.getState().paneForegroundAgentByPaneKey
      store.getState().setTabLayout('tab-1', store.getState().terminalLayoutsByTabId['tab-1'])
      expect(store.getState().paneForegroundAgentByPaneKey).toBe(before)
      const retained = {
        root: { type: 'leaf' as const, leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null
      }
      store.getState().setTabLayout('tab-1', retained)
      expect(store.getState().paneForegroundAgentByPaneKey[sibling]).toBeUndefined()
      expect(store.getState().paneForegroundAgentByPaneKey[makePaneKey('foreign-0', LEAF_1)]).toBe(
        value
      )
    }
  })

  afterEach(() => vi.restoreAllMocks())

  it('prices complete current-record selection separately from one local immutable copy at N and 10N', () => {
    for (const size of [10, 100]) {
      for (const action of ['no-removal', 'removal', 'equal'] as const) {
        const store = createTestStore()
        const target = makePaneKey('tab-1', LEAF_1)
        const sibling = makePaneKey('tab-1', LEAF_2)
        const layout = {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, leafId: LEAF_1 },
            second: { type: 'leaf' as const, leafId: LEAF_2 }
          },
          activeLeafId: LEAF_2,
          expandedLeafId: null
        }
        const value = { agent: 'pi' as const, shellForeground: false }
        const entries: Record<string, PaneForegroundAgentEntry> = Object.fromEntries(
          Array.from({ length: size }, (_, i) => [makePaneKey(`foreign-${i}`, LEAF_1), value])
        )
        entries[target] = value
        entries[sibling] = value
        let inRetraction = false
        let pendingCopyKey: string | symbol | undefined
        const work = {
          selectionPasses: 0,
          selectionKeys: 0,
          relevantReads: 0,
          unrelatedSelectionReads: 0,
          copyPasses: 0,
          copyKeys: 0,
          copyReads: 0,
          rawOwnKeys: 0,
          rawReads: 0,
          leafSets: 0,
          leafVisits: 0
        }
        const tracked = new Proxy(entries, {
          ownKeys(record) {
            work.rawOwnKeys++
            const keys = Reflect.ownKeys(record)
            if (work.rawOwnKeys === 1) {
              work.selectionPasses++
              work.selectionKeys += keys.length
            } else {
              work.copyPasses++
              work.copyKeys += keys.length
            }
            return keys
          },
          getOwnPropertyDescriptor(record, key) {
            if (work.rawOwnKeys > 1) {
              pendingCopyKey = key
            }
            return Reflect.getOwnPropertyDescriptor(record, key)
          },
          get(record, key, receiver) {
            work.rawReads++
            if (pendingCopyKey === key) {
              work.copyReads++
              pendingCopyKey = undefined
            } else if (key === target || key === sibling) {
              work.relevantReads++
            } else {
              work.unrelatedSelectionReads++
            }
            return Reflect.get(record, key, receiver)
          }
        })
        store.setState({
          terminalLayoutsByTabId: { 'tab-1': layout },
          paneForegroundAgentByPaneKey: tracked
        })
        const originalRetraction = foreground.buildForegroundLayoutRetractionPatch
        vi.spyOn(foreground, 'buildForegroundLayoutRetractionPatch').mockImplementation(
          (...args) => {
            inRetraction = true
            try {
              return originalRetraction(...args)
            } finally {
              inRetraction = false
            }
          }
        )
        const originalLeaves = leaves.collectLeafIds
        vi.spyOn(leaves, 'collectLeafIds').mockImplementation((root) => {
          const result = originalLeaves(root)
          if (inRetraction) {
            work.leafSets++
            work.leafVisits += result.length
          }
          return result
        })
        const next =
          action === 'removal'
            ? { ...layout, root: { type: 'leaf' as const, leafId: LEAF_2 } }
            : { ...layout, expandedLeafId: action === 'no-removal' ? LEAF_2 : null }
        store.getState().setTabLayout('tab-1', next)
        const observed = { ...work }
        const result = store.getState().paneForegroundAgentByPaneKey
        console.info(
          'candidate-A-local-work',
          JSON.stringify({ size, P: size + 2, K: 2, action, ...observed })
        )
        expect(observed).toEqual(
          action === 'equal'
            ? {
                selectionPasses: 0,
                selectionKeys: 0,
                relevantReads: 0,
                unrelatedSelectionReads: 0,
                copyPasses: 0,
                copyKeys: 0,
                copyReads: 0,
                rawOwnKeys: 0,
                rawReads: 0,
                leafSets: 0,
                leafVisits: 0
              }
            : {
                selectionPasses: 1,
                selectionKeys: size + 2,
                relevantReads: 2,
                unrelatedSelectionReads: 0,
                copyPasses: action === 'removal' ? 1 : 0,
                copyKeys: action === 'removal' ? size + 2 : 0,
                copyReads: action === 'removal' ? size + 2 : 0,
                rawOwnKeys: action === 'removal' ? 2 : 1,
                rawReads: action === 'removal' ? size + 4 : 2,
                leafSets: 1,
                leafVisits: action === 'removal' ? 1 : 2
              }
        )
        expect(result === tracked).toBe(action !== 'removal')
        expect(result[target]).toBe(action === 'removal' ? undefined : value)
        expect(result[sibling]).toBe(value)
        expect(result[makePaneKey('foreign-0', LEAF_1)]).toBe(value)
        vi.restoreAllMocks()
      }
    }
  })

  it('retracts real published omitted leaves with absent or partial old inventory without losing valid associations', () => {
    const original = useAppStore.getState()
    try {
      for (const inventory of ['absent', 'partial'] as const) {
        useAppStore.setState({
          terminalLayoutsByTabId: {},
          paneForegroundAgentByPaneKey: {},
          agentStatusByPaneKey: {},
          agentLaunchConfigByPaneKey: {},
          tabsByWorktree: {},
          recentlyRetiredAgentStatusPaneKeys: {},
          recentlyClosedAgentStatusTabIds: {}
        })
        const keys = [
          makePaneKey('tab-1', LEAF_1),
          makePaneKey('tab-1', LEAF_2),
          makePaneKey('tab-1', LEAF_3),
          makePaneKey('foreign', LEAF_1)
        ]
        for (const [i, key] of keys.entries()) {
          createTerminalForegroundPublication({
            execution: {},
            paneKey: key,
            tabId: i === 3 ? 'foreign' : 'tab-1',
            worktreeId: 'wt',
            cwd: '/tmp',
            startup: undefined,
            isLive: () => true,
            getPtyId: () => `pty-${i}`,
            getExpectedIncarnationId: () => 'inc',
            isVisible: () => false,
            observeForegroundAgentProcess: () => {},
            onConfirmedShellForeground: () => {},
            flushPendingInterruptInference: () => false,
            dropCommandFinishedStatusIfSameTurn: () => {}
          }).publish({
            agent: i === 0 ? 'codex' : 'pi',
            agentEvidence: 'process-read',
            shellForeground: false
          })
        }
        const entries = useAppStore.getState().paneForegroundAgentByPaneKey
        expect(keys.every((key) => entries[key]?.context?.execution)).toBe(true)
        useAppStore.getState().setTabLayout('tab-1', null)
        expect(useAppStore.getState().paneForegroundAgentByPaneKey).toBe(entries)
        if (inventory === 'partial') {
          useAppStore.setState({
            terminalLayoutsByTabId: {
              'tab-1': {
                root: { type: 'leaf', leafId: LEAF_2 },
                activeLeafId: LEAF_2,
                expandedLeafId: null
              }
            }
          })
        }
        const accepted = {
          root: {
            type: 'split' as const,
            direction: 'vertical' as const,
            first: { type: 'leaf' as const, leafId: LEAF_2 },
            second: { type: 'leaf' as const, leafId: LEAF_3 }
          },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: 'pty-1', [LEAF_3]: 'pty-2' }
        }
        useAppStore.getState().setTabLayout('tab-1', accepted)
        const result = useAppStore.getState().paneForegroundAgentByPaneKey
        expect(result[keys[0]]).toBeUndefined()
        for (const key of keys.slice(1)) {
          expect(result[key]).toBe(entries[key])
        }
        let notices = 0
        const stop = whenCodexTerminalAppears(() => {
          notices++
        })
        stop()
        expect(notices).toBe(0)
        useAppStore.getState().setTabLayout('tab-1', accepted)
        expect(useAppStore.getState().paneForegroundAgentByPaneKey).toBe(result)
        useAppStore.getState().setTabLayout('tab-1', { ...accepted, expandedLeafId: LEAF_2 })
        expect(useAppStore.getState().paneForegroundAgentByPaneKey).toBe(result)
        useAppStore.getState().setTabLayout('tab-1', null)
        expect(useAppStore.getState().paneForegroundAgentByPaneKey).toBe(result)
      }
    } finally {
      useAppStore.setState(original, true)
    }
  })

  it('normalizes duplicate PTY surfaces at the renderer state boundary', () => {
    const store = createTestStore()

    store.getState().setTabLayout('tab-1', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(store.getState().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-agent' }
    })
  })

  it('preserves valid live layouts and legacy leaf ids by identity', () => {
    const store = createTestStore()
    const layout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: 'pane:1' },
        second: { type: 'leaf' as const, leafId: 'pane:2' }
      },
      activeLeafId: 'pane:2',
      expandedLeafId: 'pane:1',
      ptyIdsByLeafId: {
        'pane:1': 'pty-local',
        'pane:2': 'remote:env-1@@term_remote'
      }
    }

    store.getState().setTabLayout('tab-1', layout)

    expect(store.getState().terminalLayoutsByTabId['tab-1']).toBe(layout)
  })

  it('moves live and future pane authority onto the retained PTY leaf', () => {
    const store = createTestStore()
    const removedPaneKey = makePaneKey('tab-1', LEAF_1)
    const retainedPaneKey = makePaneKey('tab-1', LEAF_2)
    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'before repair',
      agentType: 'codex'
    })

    store.getState().setTabLayout('tab-1', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-agent',
        [LEAF_2]: 'pty-agent'
      }
    })

    expect(store.getState().agentStatusByPaneKey[removedPaneKey]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[retainedPaneKey]?.prompt).toBe('before repair')
    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(retainedPaneKey)

    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'after repair',
      agentType: 'codex'
    })
    expect(store.getState().agentStatusByPaneKey[retainedPaneKey]?.prompt).toBe('after repair')
  })

  it('moves hydrated pane authority onto the retained PTY leaf', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const removedPaneKey = makePaneKey('tab-1', LEAF_1)
    const retainedPaneKey = makePaneKey('tab-1', LEAF_2)
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    store.getState().setAgentStatus(removedPaneKey, {
      state: 'working',
      prompt: 'before hydration',
      agentType: 'codex'
    })

    store.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: 'pty-agent' })]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_1 },
            second: { type: 'leaf', leafId: LEAF_2 }
          },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [LEAF_1]: 'pty-agent',
            [LEAF_2]: 'pty-agent'
          }
        }
      }
    })

    expect(store.getState().agentStatusByPaneKey[removedPaneKey]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[retainedPaneKey]?.prompt).toBe('before hydration')
    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(retainedPaneKey)
  })

  it('does not steal authority from a pane that was already detached to another tab', () => {
    const store = createTestStore()
    const removedPaneKey = makePaneKey('source-tab', LEAF_1)
    const retainedPaneKey = makePaneKey('source-tab', LEAF_2)
    const detachedPaneKey = makePaneKey('target-tab', LEAF_1)
    store.getState().setTabLayout('target-tab', {
      root: { type: 'leaf', leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-detached' }
    })
    store.getState().transferAgentPaneAuthority({
      fromPaneKey: removedPaneKey,
      toPaneKey: detachedPaneKey,
      ptyId: 'pty-detached'
    })

    store.getState().setTabLayout('source-tab', {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_1 },
        second: { type: 'leaf', leafId: LEAF_2 }
      },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_1]: 'pty-detached',
        [LEAF_2]: 'pty-detached'
      }
    })

    expect(resolveAgentPaneAuthorityKey(removedPaneKey)).toBe(detachedPaneKey)
    expect(resolveAgentPaneAuthorityKey(detachedPaneKey)).toBe(detachedPaneKey)
    expect(resolveAgentPaneAuthorityKey(retainedPaneKey)).toBe(retainedPaneKey)
  })

  it('repairs duplicate legacy leaf ownership without throwing', () => {
    const store = createTestStore()

    expect(() =>
      store.getState().setTabLayout('tab-1', {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'pane:1' },
          second: { type: 'leaf', leafId: 'pane:2' }
        },
        activeLeafId: 'pane:2',
        expandedLeafId: null,
        ptyIdsByLeafId: {
          'pane:1': 'pty-agent',
          'pane:2': 'pty-agent'
        }
      })
    ).not.toThrow()
    expect(store.getState().terminalLayoutsByTabId['tab-1']).toEqual({
      root: { type: 'leaf', leafId: 'pane:2' },
      activeLeafId: 'pane:2',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'pane:2': 'pty-agent' }
    })
  })

  it('scopes ownership to a tab so detach handoffs can share a PTY across tabs', () => {
    const store = createTestStore()
    const sourceLayout = {
      root: { type: 'leaf' as const, leafId: LEAF_1 },
      activeLeafId: LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_1]: 'pty-detached' }
    }
    const targetLayout = {
      root: { type: 'leaf' as const, leafId: LEAF_2 },
      activeLeafId: LEAF_2,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_2]: 'pty-detached' }
    }

    store.getState().setTabLayout('source-tab', sourceLayout)
    store.getState().setTabLayout('target-tab', targetLayout)

    expect(store.getState().terminalLayoutsByTabId['source-tab']).toBe(sourceLayout)
    expect(store.getState().terminalLayoutsByTabId['target-tab']).toBe(targetLayout)
  })
})
