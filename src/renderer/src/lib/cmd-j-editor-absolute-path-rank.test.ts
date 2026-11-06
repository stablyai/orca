import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { OpenFile } from '@/store/slices/editor'
import { buildSearchableWorkspaceTabs, searchWorkspaceTabs } from './workspace-tab-palette-search'

const WORKTREE_ID = 'repo-atlas::/home/dev/projects/atlas/main'

const worktree: Worktree = {
  id: WORKTREE_ID,
  repoId: 'repo-atlas',
  path: '/home/dev/projects/atlas/main',
  head: 'abc123',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'main',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function makeTab(overrides: Partial<Tab>): Tab {
  return {
    id: 'tab',
    entityId: 'entity',
    groupId: 'group',
    worktreeId: WORKTREE_ID,
    contentType: 'terminal',
    label: 'Tab',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

const editorFile: OpenFile = {
  id: 'file-1',
  filePath: '/home/dev/projects/atlas/main/src/server.ts',
  relativePath: 'src/server.ts',
  worktreeId: WORKTREE_ID,
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}

function buildEntries() {
  return buildSearchableWorkspaceTabs({
    worktrees: [worktree],
    repoMap: new Map([['repo-atlas', { displayName: 'atlas' }]]),
    worktreeOrder: new Map(),
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: 'terminal-1', entityId: 'terminal-1', label: 'Claude Code', sortOrder: 0 }),
        makeTab({ id: 'editor-1', entityId: editorFile.id, contentType: 'editor', sortOrder: 1 })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'terminal-1',
          ptyId: 'pty-1',
          worktreeId: WORKTREE_ID,
          title: 'Claude Code',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    openFiles: [editorFile],
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    activeGroupIdByWorktree: {},
    groupsByWorktree: {},
    activeWorktreeId: null,
    activeTabType: 'terminal',
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    generatedTitlesEnabled: true
  })
}

describe('Cmd-J editor absolute path ranking', () => {
  it('does not rank a file above a terminal because its absolute path contains the repo name', () => {
    expect(searchWorkspaceTabs(buildEntries(), 'atlas').map((result) => result.tabId)).toEqual([
      'terminal-1',
      'editor-1'
    ])
  })
})
