import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { GitHubWorkItem, JiraIssue, Worktree } from '../../../../shared/types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import {
  createWorktreeNavHistorySlice,
  findPrevLiveWorktreeHistoryIndex,
  setWorktreeNavActivator,
  setWorktreeNavViewActivator,
  type WorktreeNavHistorySimpleViewEntry
} from './worktree-nav-history'

type MinimalState = Pick<
  AppState,
  | 'worktreeNavHistory'
  | 'worktreeNavHistoryIndex'
  | 'isNavigatingHistory'
  | 'recordWorktreeVisit'
  | 'recordViewVisit'
  | 'goBackWorktree'
  | 'goForwardWorktree'
  | 'worktreesByRepo'
>

function makeWorktree(id: string): Worktree {
  return { id } as unknown as Worktree
}

function createHistoryStore(worktreeIds: string[] = []): StoreApi<MinimalState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((set, get, api) => ({
    worktreesByRepo: {
      'repo-1': worktreeIds.map(makeWorktree)
    },
    ...createWorktreeNavHistorySlice(
      set as Parameters<typeof createWorktreeNavHistorySlice>[0],
      get as Parameters<typeof createWorktreeNavHistorySlice>[1],
      api as Parameters<typeof createWorktreeNavHistorySlice>[2]
    )
  })) as unknown as StoreApi<MinimalState>
}

const viewCases: { entry: WorktreeNavHistorySimpleViewEntry; label: string }[] = [
  { entry: 'tasks', label: 'Tasks' },
  { entry: 'automations', label: 'Automations' }
]

function makeGitHubWorkItem(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'pr-95',
    type: 'pr',
    number: 95,
    title: 'feat: add file upload command',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/95',
    labels: [],
    updatedAt: '2026-05-20T00:00:00.000Z',
    author: 'octocat',
    repoId: 'repo-1',
    ...overrides
  }
}

function makeGitLabWorkItem(overrides: Partial<GitLabWorkItem> = {}): GitLabWorkItem {
  return {
    id: 'mr-12',
    type: 'mr',
    number: 12,
    title: 'Fix runner routing',
    state: 'opened',
    url: 'https://gitlab.com/acme/repo/-/merge_requests/12',
    labels: [],
    updatedAt: '2026-05-20T00:00:00.000Z',
    author: 'gitlab-user',
    repoId: 'repo-1',
    ...overrides
  }
}

function makeJiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: 'ORC-1',
    key: 'ORC-1',
    title: 'Fix task source context',
    url: 'https://example.atlassian.net/browse/ORC-1',
    siteId: 'site-1',
    siteName: 'Example Jira',
    project: { id: '10000', key: 'ORC', name: 'Orca', siteId: 'site-1' },
    issueType: { id: '10001', name: 'Bug' },
    status: { id: '1', name: 'Todo', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
    ...overrides
  }
}

describe('worktree-nav-history slice: view entries', () => {
  afterEach(() => {
    setWorktreeNavActivator(null)
    setWorktreeNavViewActivator(null)
  })

  for (const { entry, label } of viewCases) {
    it(`A -> ${label} -> B, back lands on ${label} then A`, () => {
      const store = createHistoryStore(['a', 'b'])
      const activated: string[] = []
      const viewed: WorktreeNavHistorySimpleViewEntry[] = []
      setWorktreeNavActivator((id) => {
        activated.push(id as string)
        return { primaryTabId: null }
      })
      setWorktreeNavViewActivator((v) => {
        viewed.push(v as WorktreeNavHistorySimpleViewEntry)
      })

      store.getState().recordWorktreeVisit('a')
      store.getState().recordViewVisit(entry)
      store.getState().recordWorktreeVisit('b')

      expect(store.getState().worktreeNavHistory).toEqual(['a', entry, 'b'])
      expect(store.getState().worktreeNavHistoryIndex).toBe(2)

      store.getState().goBackWorktree()
      expect(viewed).toEqual([entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)

      store.getState().goBackWorktree()
      expect(activated).toEqual(['a'])
      expect(store.getState().worktreeNavHistoryIndex).toBe(0)
    })

    it(`dedupes ${label} against the current ${label} entry`, () => {
      const store = createHistoryStore(['a'])
      store.getState().recordWorktreeVisit('a')
      store.getState().recordViewVisit(entry)
      store.getState().recordViewVisit(entry)
      store.getState().recordViewVisit(entry)

      expect(store.getState().worktreeNavHistory).toEqual(['a', entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    })

    it(`skips a dead worktree when backing to a prior ${label} entry`, () => {
      const store = createHistoryStore([])
      const viewed: WorktreeNavHistorySimpleViewEntry[] = []
      setWorktreeNavViewActivator((v) => {
        viewed.push(v as WorktreeNavHistorySimpleViewEntry)
      })

      store.setState({
        worktreeNavHistory: [entry, 'b', entry],
        worktreeNavHistoryIndex: 2
      })

      store.getState().goBackWorktree()
      expect(viewed).toEqual([entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(0)
    })

    it(`close-page-style rewind for ${label} preserves forward replay`, () => {
      const store = createHistoryStore(['a'])
      store.getState().recordWorktreeVisit('a')
      store.getState().recordViewVisit(entry)
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)

      const prev = findPrevLiveWorktreeHistoryIndex(store.getState() as AppState)
      expect(prev).toBe(0)
      store.setState({ worktreeNavHistoryIndex: prev ?? store.getState().worktreeNavHistoryIndex })

      const viewed: WorktreeNavHistorySimpleViewEntry[] = []
      setWorktreeNavViewActivator((v) => {
        viewed.push(v as WorktreeNavHistorySimpleViewEntry)
      })

      store.getState().goForwardWorktree()
      expect(viewed).toEqual([entry])
      expect(store.getState().worktreeNavHistoryIndex).toBe(1)
    })
  }

  it('replays task detail entries through the same back/forward stack', () => {
    const store = createHistoryStore(['a'])
    const detail = {
      kind: 'task-detail',
      source: 'github',
      workItem: makeGitHubWorkItem(),
      initialTab: 'checks'
    } as const
    const viewed: unknown[] = []
    setWorktreeNavViewActivator((v) => {
      viewed.push(v)
    })

    store.getState().recordWorktreeVisit('a')
    store.getState().recordViewVisit('tasks')
    store.getState().recordViewVisit(detail)

    expect(store.getState().worktreeNavHistory).toEqual(['a', 'tasks', detail])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)

    store.getState().goBackWorktree()
    expect(viewed).toEqual(['tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)

    store.getState().goForwardWorktree()
    expect(viewed).toEqual(['tasks', detail])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)
  })

  it('keeps same GitHub item details separate when the source host differs', () => {
    const store = createHistoryStore(['a'])
    const workItem = makeGitHubWorkItem()
    const localSource: TaskSourceContext = {
      kind: 'task-source',
      provider: 'github',
      projectId: 'project-1',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'repo' }
    }
    const sshSource: TaskSourceContext = {
      ...localSource,
      hostId: 'ssh:devbox',
      projectHostSetupId: 'setup-ssh'
    }

    store.getState().recordViewVisit({
      kind: 'task-detail',
      source: 'github',
      workItem,
      sourceContext: localSource
    })
    store.getState().recordViewVisit({
      kind: 'task-detail',
      source: 'github',
      workItem,
      sourceContext: sshSource
    })

    expect(store.getState().worktreeNavHistory).toHaveLength(2)
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })

  it('keeps same GitLab item details separate when the source host differs', () => {
    const store = createHistoryStore(['a'])
    const workItem = makeGitLabWorkItem()
    const localSource: TaskSourceContext = {
      kind: 'task-source',
      provider: 'gitlab',
      projectId: 'project-1',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: { provider: 'gitlab', projectId: '1234' }
    }
    const sshSource: TaskSourceContext = {
      ...localSource,
      hostId: 'ssh:devbox',
      projectHostSetupId: 'setup-ssh'
    }

    store.getState().recordViewVisit({
      kind: 'task-detail',
      source: 'gitlab',
      workItem,
      sourceContext: localSource
    })
    store.getState().recordViewVisit({
      kind: 'task-detail',
      source: 'gitlab',
      workItem,
      sourceContext: sshSource
    })

    expect(store.getState().worktreeNavHistory).toHaveLength(2)
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })

  it('keeps same Jira issue details separate when the source host differs', () => {
    const store = createHistoryStore(['a'])
    const issue = makeJiraIssue()
    const localSource: TaskSourceContext = {
      kind: 'task-source',
      provider: 'jira',
      projectId: 'project-1',
      hostId: 'local',
      providerIdentity: { provider: 'jira', siteId: 'site-1' }
    }
    const remoteSource: TaskSourceContext = {
      ...localSource,
      hostId: 'runtime:remote-server'
    }

    store.getState().recordViewVisit({
      kind: 'task-detail',
      source: 'jira',
      issue,
      sourceContext: localSource
    })
    store.getState().recordViewVisit({
      kind: 'task-detail',
      source: 'jira',
      issue,
      sourceContext: remoteSource
    })

    expect(store.getState().worktreeNavHistory).toHaveLength(2)
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })
})
