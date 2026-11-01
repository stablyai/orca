// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { ProjectConversationList } from './ProjectConversationList'
import {
  conversationListProps,
  conversationRepos,
  conversationStore,
  conversationWorktrees,
  conversationSessions
} from './ProjectConversationList.test-fixture'
import {
  conversationPreferenceKey,
  updateConversationPreference,
  type ConversationPreferences
} from '../../../../shared/conversation-navigation-preferences'
const state = vi.hoisted(() => {
  const preferences: ConversationPreferences = { revision: 0, entries: {} }
  return {
    preferences,
    setPreference: vi.fn(),
    projectVisibilitySupported: true,
    setProjectHidden: vi.fn()
  }
})
vi.mock('./use-conversation-preferences', () => ({ useConversationPreferences: () => state }))
vi.mock('./SidebarConversationStart', () => ({
  SidebarConversationStart: ({
    worktreeId,
    projectName
  }: {
    worktreeId: string
    projectName: string
  }) => <button data-workspace={worktreeId}>New chat in {projectName}</button>
}))
vi.mock('../right-sidebar/use-ai-vault-session-display-title', () => ({
  useAiVaultSessionDisplayTitle: (session: { title: string }) => session.title
}))
beforeEach(() => {
  state.preferences = { revision: 0, entries: {} }
  state.projectVisibilitySupported = true
  state.setPreference.mockReset().mockResolvedValue(undefined)
  state.setProjectHidden
    .mockReset()
    .mockImplementation(async (projectKey: string, label: string, hidden: boolean) => {
      state.preferences = updateConversationPreference(state.preferences, {
        projectKey,
        label,
        hidden
      })
    })
  useAppStore.setState(conversationStore)
})
afterEach(cleanup)
function mount(props = conversationListProps()) {
  return render(
    <TooltipProvider>
      <ProjectConversationList {...props} />
    </TooltipProvider>
  )
}
describe('Projects containing conversations', () => {
  it('shows five recent chats with project icons, then progressively reveals more', () => {
    mount()
    const project = screen.getByRole('region', { name: 'Orca' })
    expect(project.querySelectorAll('[data-conversation-id]')).toHaveLength(5)
    expect(within(project).getByText('🐋')).toBeTruthy()
    fireEvent.click(within(project).getByRole('button', { name: 'Show more' }))
    expect(project.querySelectorAll('[data-conversation-id]')).toHaveLength(7)
    expect(within(project).queryByRole('button', { name: 'Show more' })).toBeNull()
  })
  it('selects the focused chat while the legacy terminal selection is retained', () => {
    const workspaceId = conversationWorktrees[0]!.id
    const props = conversationListProps()
    props.groups = [
      {
        ...props.groups[0]!,
        sessions: [
          {
            ...conversationSessions[0]!,
            structuredSession: { sessionId: 'active-session', workspaceId }
          }
        ]
      }
    ]
    useAppStore.setState({
      activeWorktreeId: workspaceId,
      activeTabId: 'remembered-terminal',
      activeGroupIdByWorktree: { [workspaceId]: 'focused-group' },
      groupsByWorktree: {
        [workspaceId]: [
          {
            id: 'focused-group',
            worktreeId: workspaceId,
            activeTabId: 'chat-tab',
            tabOrder: ['chat-tab']
          }
        ]
      },
      unifiedTabsByWorktree: {
        [workspaceId]: [
          {
            id: 'chat-tab',
            entityId: 'active-session',
            groupId: 'focused-group',
            worktreeId: workspaceId,
            executionHostId: 'local',
            contentType: 'agent-session',
            label: 'Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })
    mount(props)
    expect(
      screen
        .getByRole('button', { name: conversationSessions[0]!.title })
        .getAttribute('aria-current')
    ).toBe('page')
  })
  it('targets each project’s new-chat action at its own workspace', () => {
    mount()
    expect(screen.getByRole('button', { name: 'New chat in Orca' }).dataset.workspace).toBe(
      conversationWorktrees[0]!.id
    )
    expect(screen.getByRole('button', { name: 'New chat in Djinn' }).dataset.workspace).toBe(
      conversationWorktrees[1]!.id
    )
  })
  it('keeps archived chats reachable and writes pin/archive against the durable key', () => {
    state.preferences = {
      revision: 1,
      entries: { [conversationPreferenceKey(conversationSessions[0]!)]: { archived: true } }
    }
    mount()
    expect(screen.queryByText(conversationSessions[0]!.title)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    const chat = screen.getByText(conversationSessions[0]!.title).closest('[data-conversation-id]')
    if (!(chat instanceof HTMLElement)) {
      throw new Error('Expected a conversation row')
    }
    fireEvent.click(within(chat).getByRole('button', { name: 'Restore chat' }))
    expect(state.setPreference).toHaveBeenCalledWith(
      conversationPreferenceKey(conversationSessions[0]!),
      { archived: false }
    )
  })
  it('does not truncate search matches and excludes only proven empty conversations', () => {
    const props = conversationListProps()
    props.query = 'history'
    props.groups = [
      {
        ...props.groups[0]!,
        sessions: [
          ...conversationSessions,
          {
            ...conversationSessions[0]!,
            id: 'empty',
            sessionId: 'empty',
            conversationContent: 'empty'
          }
        ]
      }
    ]
    const result = mount(props)
    expect(result.container.querySelectorAll('[data-conversation-id]')).toHaveLength(7)
  })
})

it('reuses registered project settings and removal confirmation actions', async () => {
  mount()
  await userEvent.click(screen.getByRole('button', { name: 'Project actions for Orca' }))
  expect(screen.getByRole('menuitem', { name: 'Project Settings' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Change Project Icon' })).toBeTruthy()
  await userEvent.click(screen.getByRole('menuitem', { name: 'Remove Project' }))
  expect(useAppStore.getState().activeModal).toBe('confirm-remove-folder')
  expect(useAppStore.getState().modalData).toMatchObject({ repoId: 'orca', hostId: 'local' })
})

it('hides a history-only group and restores it through management without requiring a workspace', async () => {
  const props = conversationListProps()
  const session = { ...conversationSessions[0]!, id: 'lost', cwd: '/lost' }
  props.groups = [{ key: 'lost', label: 'Lost', sessions: [session] }]
  props.sessionProjects = new Map([
    ['lost', { kind: 'folder', key: 'folder:/lost', label: 'Lost' }]
  ])
  const view = mount(props)
  await userEvent.click(screen.getByRole('button', { name: 'Project options for Lost' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Hide project from list' }))
  const redraw = () =>
    view.rerender(
      <TooltipProvider>
        <ProjectConversationList {...props} />
      </TooltipProvider>
    )
  redraw()
  expect(screen.queryByRole('region', { name: 'Lost' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New chat in Lost' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Hidden projects' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Restore Lost' }))
  redraw()
  expect(screen.getByRole('region', { name: 'Lost' })).toBeTruthy()
})

it('keeps visibility actions disabled until the host advertises support', async () => {
  state.projectVisibilitySupported = false
  mount()
  await userEvent.click(screen.getByRole('button', { name: 'Project actions for Orca' }))
  const hide = screen.getByRole('menuitem', { name: 'Hide project from list' })
  expect(hide.getAttribute('aria-disabled')).toBe('true')
  await userEvent.click(hide)
  expect(state.setProjectHidden).not.toHaveBeenCalled()
})

it('moves only the selected host project when adjacent projects share a repo id', async () => {
  const local: Repo = { ...conversationRepos[0]!, id: 'same', executionHostId: 'local' }
  const remote: Repo = {
    ...local,
    path: '/remote/orca',
    executionHostId: 'ssh:box',
    connectionId: 'box'
  }
  const catalog = projectHostSetupProjectionFromRepos([local, remote])
  const persist = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { set: persist },
      repos: { reorderForHost: vi.fn().mockResolvedValue({ status: 'applied' }) }
    }
  })
  useAppStore.setState({
    repos: [local, remote],
    projects: catalog.projects,
    projectHostSetups: catalog.setups,
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    manualRepoOrder: [],
    folderWorkspaces: []
  })
  mount({
    ...conversationListProps(),
    groups: [],
    sessionProjects: new Map(),
    executionHostScope: 'all'
  })
  const [first, second] = screen.getAllByRole('region')
  if (!first || !second) {
    throw new Error('Expected both host-qualified projects')
  }
  await userEvent.click(within(first).getByRole('button', { name: /Project actions/ }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move down' }))
  expect(useAppStore.getState().repos.map((repo) => repo.executionHostId)).toEqual([
    'ssh:box',
    'local'
  ])
  expect(persist).toHaveBeenCalledWith({
    manualRepoOrder: [
      { hostId: 'ssh:box', repoId: 'same' },
      { hostId: 'local', repoId: 'same' }
    ]
  })
  vi.restoreAllMocks()
})
