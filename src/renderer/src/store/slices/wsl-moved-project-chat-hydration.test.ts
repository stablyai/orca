import { expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { Tab } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: {} }

import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import {
  collectWslMovedWorkspaceKeysFromSession,
  findWslMovedProjectForWorkspace,
  selectWslMovedChatWorkspaces
} from '../repos/wsl-moved-projects'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

// The local row's checkout, as a UNC path; the host lists the same repo id at its Linux path.
const MOVED = 'repo1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo1'
const ON_HOST = 'repo1::/home/dev/repo1'
const GROUP = 'group-1'
const TERMINAL = 'terminal-1'
const EDITOR = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo1\\README.md'
const CHAT = 'agent-session:chat-1'
const projects: WslMovedProject[] = [
  { kind: 'repo', id: 'repo1', displayName: 'Repo 1', path: MOVED, distro: 'Ubuntu' }
]

function tab(id: string, contentType: Tab['contentType'], sortOrder: number): Tab {
  return {
    id,
    entityId: contentType === 'agent-session' ? 'chat-1' : id,
    groupId: GROUP,
    worktreeId: MOVED,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

function movedSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: 'repo1',
    activeWorktreeId: MOVED,
    tabsByWorktree: { [MOVED]: [makeTab({ id: TERMINAL, worktreeId: MOVED })] },
    openFilesByWorktree: {
      [MOVED]: [{ filePath: EDITOR, relativePath: 'README.md', worktreeId: MOVED, language: 'md' }]
    },
    unifiedTabs: {
      [MOVED]: [
        tab(TERMINAL, 'terminal', 0),
        tab(EDITOR, 'editor', 1),
        tab(CHAT, 'agent-session', 2)
      ]
    },
    tabGroups: {
      [MOVED]: [
        { id: GROUP, worktreeId: MOVED, activeTabId: TERMINAL, tabOrder: [TERMINAL, EDITOR, CHAT] }
      ]
    },
    activeGroupIdByWorktree: { [MOVED]: GROUP }
  }
}

function hydrate(store: ReturnType<typeof createTestStore>, session: WorkspaceSessionState) {
  // The host's same-id repo is known and listed; without the moved keys the degraded rule would
  // keep the unlisted local worktree whole.
  store.setState({
    repos: [
      {
        id: 'repo1',
        path: '/home/dev/repo1',
        displayName: 'Repo 1',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { repo1: [] },
    wslMovedProjects: projects
  })
  const options = {
    wslMovedChatWorkspaceKeys: collectWslMovedWorkspaceKeysFromSession(session, projects)
  }
  store.getState().hydrateWorkspaceSession(session, options)
  store.getState().hydrateTabsSession(session, options)
  store.getState().hydrateEditorSession(session, options)
  store.getState().hydrateBrowserSession(session, options)
}

it("keeps only a moved project's chat tab through hydration and persistence", () => {
  const store = createTestStore()
  hydrate(store, movedSession())

  const state = store.getState()
  expect(state.unifiedTabsByWorktree[MOVED]?.map((entry) => entry.id)).toEqual([CHAT])
  expect(state.groupsByWorktree[MOVED]?.[0]?.tabOrder).toEqual([CHAT])
  expect(state.tabsByWorktree[MOVED]).toBeUndefined()
  expect(state.openFiles).toEqual([])

  store.setState({ workspaceSessionReady: true })
  store.getState().setHydrationSucceeded(true)
  const persisted = buildWorkspaceSessionPayload(store.getState())
  expect(persisted.unifiedTabs?.[MOVED]?.map((entry) => entry.id)).toEqual([CHAT])
})

it("lists the moved chats under their project, and never the host's listed worktree", () => {
  const store = createTestStore()
  hydrate(store, movedSession())
  store.setState({
    worktreesByRepo: {
      repo1: [makeWorktree({ id: ON_HOST, repoId: 'repo1', path: '/home/dev/repo1' })]
    },
    unifiedTabsByWorktree: {
      ...store.getState().unifiedTabsByWorktree,
      [ON_HOST]: [{ ...tab('agent-session:host', 'agent-session', 0), worktreeId: ON_HOST }]
    }
  })
  const state = store.getState()
  expect(findWslMovedProjectForWorkspace(state, MOVED)?.id).toBe('repo1')
  expect(findWslMovedProjectForWorkspace(state, ON_HOST)).toBeNull()
  expect(
    selectWslMovedChatWorkspaces(state).map(({ project, workspaces }) => ({
      project: project.id,
      workspaces: workspaces.map(({ key, chats }) => ({ key, chats: chats.map((c) => c.id) }))
    }))
  ).toEqual([{ project: 'repo1', workspaces: [{ key: MOVED, chats: [CHAT] }] }])
})
