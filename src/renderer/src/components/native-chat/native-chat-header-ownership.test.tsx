// @vitest-environment happy-dom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { makeTabGroup } from '@/store/slices/store-test-helpers'
import {
  makeFolderWorkspace,
  makeRepo,
  makeUnifiedTab,
  makeWorktree
} from '../worktree-jump-palette-test-fixtures'
import * as subjects from '../tab-bar/tab-session-history-switch'
import * as history from '../right-sidebar/ai-vault-panel-session-list-request'
import type { NativeChatCliForkPreparation } from '@/lib/native-chat-cli-fork-preparation'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type * as paneActions from './use-structured-chat-pane-actions'

const work = vi.hoisted(() => ({
  header: false,
  headerVisits: 0,
  otherVisits: 0,
  lookups: 0,
  commits: 0
}))
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), launch: vi.fn(), close: vi.fn() }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
vi.mock('./use-structured-chat-pane-actions', async (original) => {
  const { useStructuredChatPaneActions } = await original<typeof paneActions>()
  return {
    useStructuredChatPaneActions(...args: Parameters<typeof useStructuredChatPaneActions>) {
      work.header = true
      const actions = useStructuredChatPaneActions(...args)
      work.header = false
      return actions
    }
  }
})
vi.mock('./NativeChatView', async () => {
  const { nativeChatPaneHeader } = await import('./NativeChatPaneHeader')
  return {
    default: (props: NativeChatStructuredViewProps) => (
      <div className="native-chat-appearance" data-chat={props.tabId}>
        {nativeChatPaneHeader(props, 'folder:workspace', 'dark')}
        <output data-transcript={props.tabId}>{props.sessionId}</output>
      </div>
    )
  }
})
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: mocks.close }))
vi.mock('@/lib/native-chat-cli-fork-preparation', () => ({
  prepareNativeChatCliFork: mocks.prepare
}))
vi.mock('@/lib/launch-ai-vault-session-and-reveal', () => ({
  launchAiVaultSessionAndReveal: mocks.launch
}))
vi.mock('@/lib/ai-vault-session-fork-startup', () => ({
  assertAiVaultCopiedSessionLaunchAllowed: () => {},
  buildAiVaultForkStartupForWorktree: () => ({ command: 'fixture-fork' })
}))

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'
import { NativeChatResumeInCliButton } from './NativeChatResumeInCliButton'

const workspace = 'folder:workspace'
const initial = useAppStore.getInitialState()
const fullRequest = vi.spyOn(history, 'resolveAiVaultPanelSessionListRequest')
const identity = vi.spyOn(subjects, 'resolveNativeChatCliForkIdentity')
const testWindow = window
const originalApi = window.api
const api = createTabsSliceMockApi()
vi.stubGlobal('window', testWindow)
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { api })
  useAppStore.setState(initial, true)
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'workspace', folderPath: '/repo' })]
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  Object.assign(window, { api: originalApi })
})
function hasPropertyKey<T extends object>(target: T, key: PropertyKey): key is keyof T {
  return key in target
}
function countedTab(tab: Tab): Tab {
  return new Proxy(tab, {
    get(target, key) {
      if (key === 'groupId' || key === 'id') {
        work[work.header ? 'headerVisits' : 'otherVisits']++
      }
      return hasPropertyKey(target, key) ? target[key] : undefined
    }
  })
}
function seedChats(size: number) {
  const tabs = Array.from({ length: size }, (_, index) =>
    countedTab({
      ...makeUnifiedTab(`chat-${index}`, workspace, `session-${index}`, `Chat ${index}`),
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      executionHostId: 'local',
      groupId: index === size - 1 ? 'second' : 'first'
    })
  )
  const groups = ['first', 'second'].map((id) =>
    makeTabGroup({
      id,
      worktreeId: workspace,
      tabOrder: tabs.filter((tab) => tab.groupId === id).map((tab) => tab.id),
      activeTabId: id === 'first' ? 'chat-0' : `chat-${size - 1}`
    })
  )
  useAppStore.setState({
    unifiedTabsByWorktree: { [workspace]: tabs },
    groupsByWorktree: { [workspace]: groups },
    activeGroupIdByWorktree: { [workspace]: 'first' }
  })
}
function overlay(active: boolean) {
  return (
    <TooltipProvider>
      <StructuredAgentSessionPaneOverlayLayer worktreeId={workspace} isWorktreeActive={active} />
    </TooltipProvider>
  )
}
function chat(container: HTMLElement, id: string) {
  return within(container).getByText(`session-${id.slice(5)}`).parentElement!
}

it.each([10, 100])(
  'bounds shown header tab work at %i retained chats and keeps hidden transcripts',
  async (size) => {
    seedChats(size)
    const view = render(overlay(true))
    const retained = chat(view.container, 'chat-0').querySelector('output')
    const unfocused = chat(view.container, `chat-${size - 1}`)
    expect(within(unfocused).getByRole('button', { name: 'Close Pane' })).toBeTruthy()
    for (const operation of [
      () => useAppStore.getState().setTabLabel('chat-0', 'Changed title'),
      () => useAppStore.getState().activateTab('chat-1', { worktreeId: workspace })
    ]) {
      work.headerVisits = work.otherVisits = 0
      await act(async () => operation())
      expect(work.headerVisits).toBeGreaterThan(0)
      // Filter plus pin lookup: at most four real tab visits per shown header per tab.
      expect(work.headerVisits).toBeLessThanOrEqual(4 * 2 * size)
      expect(work.otherVisits).toBeGreaterThan(0)
    }
    expect(useAppStore.getState().getTab('chat-0')?.label).toBe('Changed title')
    expect(chat(view.container, 'chat-0').querySelector('output')).toBe(retained)
    view.rerender(overlay(false))
    work.headerVisits = 0
    await act(async () => {
      useAppStore.getState().setTabLabel('chat-1', 'Hidden title')
      useAppStore.getState().pinTab('chat-1', { recordInteraction: false })
      useAppStore.setState({
        groupsByWorktree: { [workspace]: [useAppStore.getState().groupsByWorktree[workspace][0]] }
      })
    })
    expect(work.headerVisits).toBe(0)
    expect(view.container.querySelector('.pane-title-bar')).toBeNull()
    view.rerender(overlay(true))
    const shown = chat(view.container, 'chat-1')
    expect(within(shown).queryByRole('button', { name: 'Close tab' })).toBeNull()
    act(() => useAppStore.getState().unpinTab('chat-1', { recordInteraction: false }))
    fireEvent.click(within(shown).getByRole('button', { name: 'Close tab' }))
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith({
      type: 'close',
      target: { kind: 'tab', worktreeId: workspace, tabId: 'chat-1' }
    })
    expect(chat(view.container, 'chat-0').querySelector('output')).toBe(retained)
    expect(fullRequest).not.toHaveBeenCalled()
  }
)

function countedRecords<T>(records: T[]): T[] {
  return new Proxy(records, {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        work.lookups++
      }
      return hasPropertyKey(target, key) ? target[key] : undefined
    }
  })
}
function eligibility(
  folder: string,
  git: string,
  sessionId = 'session',
  agent: subjects.NativeChatTabSession['agent'] = 'codex',
  tabId = 'tab'
) {
  return (
    <TooltipProvider>
      <Profiler id="eligibility" onRender={() => work.commits++}>
        {[
          { key: 'folder', id: folder },
          { key: 'git', id: git }
        ].map(({ key, id }) => (
          <NativeChatResumeInCliButton
            key={key}
            tabId={tabId}
            worktreeId={id}
            nativeChat={{ sessionId, agent }}
          />
        ))}
      </Profiler>
    </TooltipProvider>
  )
}

it.each([10, 100])(
  'does no idle eligibility lookup across %i workspace records and tracks all dependencies',
  async (size) => {
    const folders = countedRecords(
      Array.from({ length: size }, (_, i) =>
        makeFolderWorkspace({
          id: `folder-${i}`,
          folderPath: `/folder/${i}`,
          projectGroupId: `project-${size - 1}`
        })
      )
    )
    const groups = countedRecords(
      Array.from({ length: size }, (_, i) => ({
        id: `project-${i}`,
        name: `Project ${i}`,
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual' as const,
        tabOrder: i,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }))
    )
    const repos = countedRecords(
      Array.from({ length: size }, (_, i) => ({
        ...makeRepo(),
        id: `repo-${i}`,
        projectGroupId: `project-${size - 1}`
      }))
    )
    const worktrees = Object.fromEntries(
      repos.map((repo, i) => [
        repo.id,
        countedRecords([
          makeWorktree(`${repo.id}::/git/${i}`, `Tree ${i}`, { repoId: repo.id, path: `/git/${i}` })
        ])
      ])
    )
    const folder = `folder:folder-${size - 1}`
    const git = `repo-${size - 1}::/git/${size - 1}`
    useAppStore.setState({
      folderWorkspaces: folders,
      projectGroups: groups,
      repos,
      worktreesByRepo: worktrees
    })
    const view = render(eligibility(folder, git))
    work.lookups = work.commits = 0
    identity.mockClear()
    act(() => {
      for (let tick = 0; tick < 50; tick++) {
        useAppStore.setState({ lastTerminalInputAtByPaneKey: { 'other:pane': tick } })
      }
    })
    expect(work.lookups).toBe(0)
    expect(identity).not.toHaveBeenCalled()
    expect(work.commits).toBe(0)
    const restore = {
      folderWorkspaces: folders,
      projectGroups: groups,
      repos,
      worktreesByRepo: worktrees
    }
    const replacements: Partial<AppState>[] = [
      {
        worktreesByRepo: {
          ...worktrees,
          [`repo-${size - 1}`]: countedRecords([
            makeWorktree(git, 'missing path', { repoId: `repo-${size - 1}`, path: '' })
          ])
        }
      },
      {
        folderWorkspaces: countedRecords(
          folders.map((row, i) => (i === size - 1 ? { ...row, folderPath: '' } : row))
        )
      },
      {
        projectGroups: countedRecords(
          groups.map((row, i) => (i === size - 1 ? { ...row, executionHostId: 'ssh:dev' } : row))
        )
      },
      { repos: countedRecords(repos.map((row) => ({ ...row, executionHostId: 'ssh:dev' }))) }
    ]
    for (const replacement of replacements) {
      work.lookups = 0
      identity.mockClear()
      await act(async () => useAppStore.setState(replacement))
      expect(identity).toHaveBeenCalledTimes(2)
      expect(work.lookups).toBeGreaterThan(0)
      // Two shown buttons; existing folder candidates/groups and git lookups are linear in records.
      expect(work.lookups).toBeLessThanOrEqual(20 * 2 * size)
      const expected = [folder, git].filter((worktreeId) =>
        subjects.resolveNativeChatCliForkIdentity(useAppStore.getState(), {
          tab: { id: 'tab', worktreeId },
          nativeChat: { sessionId: 'session', agent: 'codex' }
        })
      )
      expect(screen.queryAllByRole('button')).toHaveLength(expected.length)
      await act(async () => useAppStore.setState(restore))
      expect(screen.getAllByRole('button')).toHaveLength(2)
    }
    identity.mockClear()
    view.rerender(eligibility(folder, git))
    expect(identity).not.toHaveBeenCalled()
    view.rerender(eligibility(folder, git, 'new-session'))
    expect(identity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ nativeChat: { sessionId: 'new-session', agent: 'codex' } })
    )
    identity.mockClear()
    view.rerender(eligibility(folder, git, 'new-session', 'codex', 'new-tab'))
    expect(identity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tab: { id: 'new-tab', worktreeId: folder } })
    )
    view.rerender(eligibility(folder, git, 'new-session', 'gemini', 'new-tab'))
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    view.rerender(eligibility(folder, git, 'new-session', 'codex', 'new-tab'))
    expect(screen.getAllByRole('button')).toHaveLength(2)
    view.rerender(eligibility('folder:missing', git, 'new-session', 'codex', 'new-tab'))
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(fullRequest).not.toHaveBeenCalled()
  }
)

it('keeps the real Continue pending operation disabled across header hide/reveal and launches once', async () => {
  seedChats(10)
  const preparation = Promise.withResolvers<NativeChatCliForkPreparation>()
  mocks.prepare.mockReturnValue(preparation.promise)
  mocks.launch.mockResolvedValue(undefined)
  const view = render(overlay(true))
  const source = chat(view.container, 'chat-0')
  const button = () => within(source).getByRole('button', { name: 'Continue with Terminal Agent' })
  expect(fullRequest).not.toHaveBeenCalled()
  fireEvent.click(button())
  expect(button().hasAttribute('disabled')).toBe(true)
  expect(button().getAttribute('aria-busy')).toBe('true')
  view.rerender(overlay(false))
  expect(within(source).queryByRole('button')).toBeNull()
  expect(useAppStore.getState().getTab('chat-0')).not.toBeNull()
  view.rerender(overlay(true))
  expect(button().hasAttribute('disabled')).toBe(true)
  expect(button().getAttribute('aria-busy')).toBe('true')
  fireEvent.click(button())
  expect(mocks.prepare).toHaveBeenCalledTimes(1)
  await act(async () =>
    preparation.resolve({
      copied: false,
      session: { agent: 'codex', sessionId: 'fork', cwd: '/repo', codexHome: null }
    })
  )
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  expect(button().hasAttribute('disabled')).toBe(false)
  expect(button().hasAttribute('aria-busy')).toBe(false)
  expect(fullRequest).toHaveBeenCalledTimes(1)
})
