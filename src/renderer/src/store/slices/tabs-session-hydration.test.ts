import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type * as AgentStatusModule from '@/lib/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeTabGroup, makeUnifiedTab, makeWorktree } from './store-test-helpers'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  // ─── hydrateTabsSession ───────────────────────────────────────────

  describe('hydrateTabsSession', () => {
    it('hydrates from legacy format (TerminalTab[] + PersistedOpenFile[])', () => {
      // Seed with a valid worktree
      store.setState({
        worktreesByRepo: {
          repo1: [
            {
              id: WT,
              repoId: 'repo1',
              path: '/tmp/feature',
              head: 'abc',
              branch: 'feature',
              isBare: false,
              isMainWorktree: false,
              displayName: 'feature',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              linkedGitLabMR: null,
              linkedGitLabIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        }
      })

      store.getState().hydrateTabsSession({
        activeRepoId: 'repo1',
        activeWorktreeId: WT,
        activeTabId: 'term-1',
        tabsByWorktree: {
          [WT]: [
            {
              id: 'term-1',
              ptyId: null,
              worktreeId: WT,
              title: 'zsh',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1000
            },
            {
              id: 'term-2',
              ptyId: null,
              worktreeId: WT,
              title: 'node',
              customTitle: 'dev',
              color: '#f00',
              sortOrder: 1,
              createdAt: 2000
            }
          ]
        },
        terminalLayoutsByTabId: {},
        openFilesByWorktree: {
          [WT]: [
            {
              filePath: '/tmp/feature/src/main.ts',
              relativePath: 'src/main.ts',
              worktreeId: WT,
              language: 'typescript'
            }
          ]
        },
        activeFileIdByWorktree: { [WT]: '/tmp/feature/src/main.ts' },
        activeTabTypeByWorktree: { [WT]: 'terminal' }
      })

      const state = store.getState()
      const tabs = state.unifiedTabsByWorktree[WT]
      expect(tabs).toHaveLength(3) // 2 terminals + 1 editor

      const terminal1 = tabs.find((t) => t.id === 'term-1')
      expect(terminal1?.contentType).toBe('terminal')
      expect(terminal1?.label).toBe('zsh')

      const terminal2 = tabs.find((t) => t.id === 'term-2')
      expect(terminal2?.customLabel).toBe('dev')
      expect(terminal2?.color).toBe('#f00')

      const editor = tabs.find((t) => t.id === '/tmp/feature/src/main.ts')
      expect(editor?.contentType).toBe('editor')
      expect(editor?.label).toBe('src/main.ts')

      // Group should exist with correct active tab
      const groups = state.groupsByWorktree[WT]
      expect(groups).toHaveLength(1)
      expect(groups[0].activeTabId).toBe('term-1')
      expect(groups[0].tabOrder).toEqual(['term-1', 'term-2', '/tmp/feature/src/main.ts'])
    })

    it('hydrates floating workspace unified tabs without a repo worktree', () => {
      store.getState().hydrateTabsSession({
        activeRepoId: null,
        activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-browser-1',
              entityId: 'floating-browser-1',
              groupId: 'floating-group-1',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              contentType: 'browser',
              label: 'Browser',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        tabGroups: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            {
              id: 'floating-group-1',
              worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
              activeTabId: 'floating-browser-1',
              tabOrder: ['floating-browser-1']
            }
          ]
        }
      })

      expect(store.getState().unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    })

    it('hydrates from unified format', () => {
      store.setState({
        worktreesByRepo: {
          repo1: [
            {
              id: WT,
              repoId: 'repo1',
              path: '/tmp/feature',
              head: 'abc',
              branch: 'feature',
              isBare: false,
              isMainWorktree: false,
              displayName: 'feature',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              linkedGitLabMR: null,
              linkedGitLabIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        }
      })

      const groupId = 'g-1'
      const tabs: Tab[] = [
        {
          id: 't-1',
          entityId: 't-1',
          groupId,
          worktreeId: WT,
          contentType: 'terminal',
          label: 'zsh',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1000
        },
        {
          id: '/file.ts',
          entityId: '/file.ts',
          groupId,
          worktreeId: WT,
          contentType: 'editor',
          label: 'file.ts',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2000
        }
      ]
      const groups: TabGroup[] = [
        { id: groupId, worktreeId: WT, activeTabId: '/file.ts', tabOrder: ['t-1', '/file.ts'] }
      ]

      store.getState().hydrateTabsSession({
        activeRepoId: 'repo1',
        activeWorktreeId: WT,
        activeTabId: 't-1',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { [WT]: tabs },
        tabGroups: { [WT]: groups }
      })

      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT]).toHaveLength(2)
      expect(state.groupsByWorktree[WT][0].activeTabId).toBe('/file.ts')
    })

    it('deduplicates persisted tab order during unified hydration', () => {
      store.setState({
        worktreesByRepo: {
          repo1: [
            {
              id: WT,
              repoId: 'repo1',
              path: '/tmp/feature',
              head: 'abc',
              branch: 'feature',
              isBare: false,
              isMainWorktree: false,
              displayName: 'feature',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              linkedGitLabMR: null,
              linkedGitLabIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          ]
        }
      })

      const groupId = 'g-1'
      const tabs: Tab[] = [
        {
          id: 't-1',
          entityId: 't-1',
          groupId,
          worktreeId: WT,
          contentType: 'terminal',
          label: 'zsh',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1000
        },
        {
          id: '/file.ts',
          entityId: '/file.ts',
          groupId,
          worktreeId: WT,
          contentType: 'editor',
          label: 'file.ts',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 2000
        }
      ]
      const groups: TabGroup[] = [
        {
          id: groupId,
          worktreeId: WT,
          activeTabId: '/file.ts',
          tabOrder: ['t-1', 't-1', '/file.ts', '/file.ts']
        }
      ]

      store.getState().hydrateTabsSession({
        activeRepoId: 'repo1',
        activeWorktreeId: WT,
        activeTabId: 't-1',
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        unifiedTabs: { [WT]: tabs },
        tabGroups: { [WT]: groups }
      })

      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual(['t-1', '/file.ts'])
    })

    it('filters out invalid worktree IDs during hydration', () => {
      store.setState({ worktreesByRepo: {} })

      store.getState().hydrateTabsSession({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {
          'nonexistent-wt': [
            {
              id: 't-1',
              ptyId: null,
              worktreeId: 'nonexistent-wt',
              title: 'zsh',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1000
            }
          ]
        },
        terminalLayoutsByTabId: {}
      })

      expect(store.getState().unifiedTabsByWorktree).toEqual({})
    })

    it('replaces only explicitly scoped worktree tab chrome', () => {
      const siblingWorktreeId = 'repo2::/tmp/sibling'
      const targetGroup = makeTabGroup({
        id: 'group-target',
        worktreeId: WT,
        activeTabId: 'target-old',
        tabOrder: ['target-old']
      })
      const siblingGroup = makeTabGroup({
        id: 'group-sibling',
        worktreeId: siblingWorktreeId,
        activeTabId: 'sibling-tab',
        tabOrder: ['sibling-tab']
      })
      const siblingTabs = [
        makeUnifiedTab({
          id: 'sibling-tab',
          worktreeId: siblingWorktreeId,
          groupId: siblingGroup.id
        })
      ]
      const siblingGroups = [siblingGroup]
      store.setState({
        worktreesByRepo: {
          repo1: [makeWorktree({ id: WT, repoId: 'repo1' })],
          repo2: [makeWorktree({ id: siblingWorktreeId, repoId: 'repo2' })]
        },
        unifiedTabsByWorktree: {
          [WT]: [makeUnifiedTab({ id: 'target-old', worktreeId: WT, groupId: targetGroup.id })],
          [siblingWorktreeId]: siblingTabs
        },
        groupsByWorktree: {
          [WT]: [targetGroup],
          [siblingWorktreeId]: siblingGroups
        },
        activeGroupIdByWorktree: {
          [WT]: targetGroup.id,
          [siblingWorktreeId]: siblingGroup.id
        },
        layoutByWorktree: {
          [WT]: { type: 'leaf', groupId: targetGroup.id },
          [siblingWorktreeId]: { type: 'leaf', groupId: siblingGroup.id }
        }
      })
      const targetNew = makeUnifiedTab({
        id: 'target-new',
        worktreeId: WT,
        groupId: targetGroup.id,
        label: 'Remote target'
      })

      store.getState().hydrateTabsSession(
        {
          activeRepoId: 'repo1',
          activeWorktreeId: WT,
          activeTabId: targetNew.id,
          tabsByWorktree: {},
          terminalLayoutsByTabId: {},
          unifiedTabs: {
            [WT]: [targetNew],
            [siblingWorktreeId]: [
              makeUnifiedTab({
                id: 'sibling-replaced',
                worktreeId: siblingWorktreeId,
                groupId: siblingGroup.id
              })
            ]
          },
          tabGroups: {
            [WT]: [{ ...targetGroup, activeTabId: targetNew.id, tabOrder: [targetNew.id] }],
            [siblingWorktreeId]: [
              { ...siblingGroup, activeTabId: 'sibling-replaced', tabOrder: ['sibling-replaced'] }
            ]
          }
        },
        { replaceWorkspaceKeys: [WT] }
      )

      expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([targetNew])
      expect(store.getState().unifiedTabsByWorktree[siblingWorktreeId]).toBe(siblingTabs)
      expect(store.getState().groupsByWorktree[siblingWorktreeId]).toBe(siblingGroups)
    })

    it('deletes omitted target chrome while preserving sibling references', () => {
      const siblingWorktreeId = 'repo2::/tmp/sibling'
      const targetGroup = makeTabGroup({
        id: 'group-target',
        worktreeId: WT,
        activeTabId: 'target-tab',
        tabOrder: ['target-tab']
      })
      const siblingGroup = makeTabGroup({
        id: 'group-sibling',
        worktreeId: siblingWorktreeId,
        activeTabId: 'sibling-tab',
        tabOrder: ['sibling-tab']
      })
      const siblingTabs = [
        makeUnifiedTab({
          id: 'sibling-tab',
          worktreeId: siblingWorktreeId,
          groupId: siblingGroup.id
        })
      ]
      const siblingGroups = [siblingGroup]
      const siblingLayout = { type: 'leaf' as const, groupId: siblingGroup.id }
      store.setState({
        worktreesByRepo: {
          repo1: [makeWorktree({ id: WT, repoId: 'repo1' })],
          repo2: [makeWorktree({ id: siblingWorktreeId, repoId: 'repo2' })]
        },
        unifiedTabsByWorktree: {
          [WT]: [makeUnifiedTab({ id: 'target-tab', worktreeId: WT, groupId: targetGroup.id })],
          [siblingWorktreeId]: siblingTabs
        },
        groupsByWorktree: {
          [WT]: [targetGroup],
          [siblingWorktreeId]: siblingGroups
        },
        activeGroupIdByWorktree: {
          [WT]: targetGroup.id,
          [siblingWorktreeId]: siblingGroup.id
        },
        layoutByWorktree: {
          [WT]: { type: 'leaf', groupId: targetGroup.id },
          [siblingWorktreeId]: siblingLayout
        }
      })

      store.getState().hydrateTabsSession(
        {
          activeRepoId: 'repo1',
          activeWorktreeId: WT,
          activeTabId: null,
          tabsByWorktree: {},
          terminalLayoutsByTabId: {},
          unifiedTabs: {},
          tabGroups: {}
        },
        { replaceWorkspaceKeys: [WT] }
      )

      const state = store.getState()
      expect(state.unifiedTabsByWorktree).not.toHaveProperty(WT)
      expect(state.groupsByWorktree).not.toHaveProperty(WT)
      expect(state.activeGroupIdByWorktree).not.toHaveProperty(WT)
      expect(state.layoutByWorktree).not.toHaveProperty(WT)
      expect(state.unifiedTabsByWorktree[siblingWorktreeId]).toBe(siblingTabs)
      expect(state.groupsByWorktree[siblingWorktreeId]).toBe(siblingGroups)
      expect(state.layoutByWorktree[siblingWorktreeId]).toBe(siblingLayout)
    })
  })
})
