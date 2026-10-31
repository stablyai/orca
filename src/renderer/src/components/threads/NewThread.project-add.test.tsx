// @vitest-environment happy-dom
import { setThreadTestPage } from './thread-page.test-fixture'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ListDetectedWorktreesArgs } from '../../../../shared/detected-worktree-provider-contract'
import {
  makeDetectedResult,
  qualifyDetectedResult
} from '@/store/slices/worktrees-detected-listing-fixtures'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import NonGitFolderDialog from '../sidebar/NonGitFolderDialog'
import { makeUnifiedTab, makeTabGroup } from '@/store/slices/store-test-helpers'
import { useDesktopThreadPage } from './use-desktop-thread-page'
import AddRepoDialog from '../sidebar/AddRepoDialog'
import { TooltipProvider } from '../ui/tooltip'
import { NewThread } from './NewThread'
import { activeThreadSelection } from './thread-navigation'
import { openNewThread } from './thread-actions'
import { useThreadProjectAddController } from './use-thread-project-add-controller'
import { promptEditor } from '../native-chat/native-chat-prompt-editor.test-support'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/native-chat-composer-draft-store'

vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<object>()),
  structuredAgentSessionHostSupports: async () => true
}))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', () => ({ useNewTabAgentMenuRows: () => null }))
vi.mock('../agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: () => []
}))
vi.mock('../native-chat/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))

const repo = (id: string) => ({ id, path: `/${id}`, displayName: id, addedAt: 1, badgeColor: '' })
const worktree = (id: string) =>
  makeWorktree({
    id: `${id}::/${id}`,
    repoId: id,
    path: `/${id}`,
    isMainWorktree: true,
    hostId: 'local'
  })
const launchDraft = {
  agent: 'codex' as const,
  surface: 'chat' as const,
  choices: { model: 'chosen-model', permissionMode: 'auto' as const }
}
const picker = vi.fn(async () => ['/C'])
let addedMainCheckout = true
function Surface() {
  const selection = useDesktopThreadPage()
  const modal = useAppStore((s) => s.activeModal)
  const hosted = useThreadProjectAddController()
  return (
    <TooltipProvider>
      <output data-testid="page">{selection?.kind ?? 'workbench'}</output>
      <NonGitFolderDialog />
      {selection?.kind === 'new' ? (
        <NewThread {...selection} />
      ) : (
        <button onClick={() => void openNewThread()}>New thread</button>
      )}
      {modal === 'add-repo' ? <AddRepoDialog hosted={hosted} /> : null}
    </TooltipProvider>
  )
}
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  vi.clearAllMocks()
  addedMainCheckout = true
  setThreadTestPage({
    selection: { kind: 'new', projectKey: 'local|A', draftId: 'same-draft', launchDraft },
    projectRequest: null
  })
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalThreads: true },
    activeModal: 'none',
    activeView: 'thread-draft',
    activeWorktreeId: 'A::/A',
    activeWorkspaceExecutionHostId: 'local',
    repos: [repo('A')],
    worktreesByRepo: { A: [worktree('A')] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    lastVisitedAtByWorktreeId: {},
    runtimeEnvironments: []
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: {
        pickFolders: picker,
        add: vi.fn(async () => ({ repo: repo('C') })),
        cloneAbort: vi.fn(async () => {}),
        onCloneProgress: () => () => {},
        getDefaultCreateProjectParent: async () => '/tmp',
        isGitAvailable: async () => true
      },
      projectGroups: {
        onNestedScanProgress: () => () => {},
        scanNested: async () => ({
          selectedPath: '/C',
          selectedPathKind: 'git_repo',
          repos: [],
          stopped: false,
          maxDepth: 3,
          maxRepos: 100,
          timeoutMs: null
        })
      },
      worktrees: {
        listDetected: async (args: ListDetectedWorktreesArgs) =>
          qualifyDetectedResult(
            args,
            makeDetectedResult('C', [{ ...worktree('C'), isMainWorktree: addedMainCheckout }])
          )
      }
    }
  })
})
afterEach(cleanup)
it.each(['complete', 'cancel', 'empty', 'ineligible', 'superseded'] as const)(
  'uses the real hosted Git dialog continuation from %s without checkout navigation',
  async (entry) => {
    if (entry === 'ineligible') {
      addedMainCheckout = false
    }
    if (entry === 'superseded') {
      picker.mockImplementationOnce(async () => {
        await openNewThread()
        return ['/C']
      })
    }
    if (entry === 'empty') {
      setThreadTestPage({ selection: null })
      useAppStore.setState({ repos: [], worktreesByRepo: {} })
    }
    render(<Surface />)
    if (entry === 'empty') {
      fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    } else {
      const composer = await screen.findByRole('textbox', { name: /Ask for changes/ })
      await waitFor(() => expect(composer.getAttribute('contenteditable')).toBe('true'))
      await waitFor(() => expect(promptEditor(composer)).toBeTruthy())
      act(() => promptEditor(composer).commands.insertContent('P in the same draft'))
      fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
      fireEvent.click(screen.getByRole('option', { name: 'Add project' }))
    }
    await screen.findByRole('dialog')
    if (entry === 'cancel') {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    } else {
      fireEvent.click(screen.getByRole('button', { name: /Browse folder/ }))
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Choose project' }).textContent).toBe(
        entry === 'cancel' || entry === 'ineligible' || entry === 'superseded' ? 'A' : 'C'
      )
    )
    expect(screen.getByRole('textbox', { name: /Ask for changes/ }).textContent).toBe(
      entry === 'empty' ? '' : 'P in the same draft'
    )
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /Ask for changes/ }))
    )
    expect(useAppStore.getState().activeWorktreeId).toBe('A::/A')
    expect(Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()).toEqual([])
    if (entry !== 'empty' && entry !== 'superseded') {
      expect(activeThreadSelection(useAppStore.getState())).toMatchObject({
        draftId: 'same-draft',
        launchDraft
      })
    }
    if (entry === 'superseded') {
      expect(activeThreadSelection(useAppStore.getState())).toMatchObject({
        draftId: 'same-draft',
        launchDraft
      })
    }
  }
)

it.each([true, false])(
  'folder handoff reveals a previously-added folder (thread requester=%s)',
  async (threadRequester) => {
    const C = { ...repo('C'), kind: 'folder' as const, executionHostId: 'local' as const }
    const wt = { ...worktree('C'), isMainWorktree: false }
    const tab = makeUnifiedTab({
      id: 'existing-editor',
      worktreeId: wt.id,
      contentType: 'editor',
      entityId: '/C/file',
      groupId: 'C-group',
      executionHostId: 'local'
    })
    useAppStore.setState({
      repos: [repo('A'), C],
      worktreesByRepo: { A: [worktree('A')], C: [wt] },
      unifiedTabsByWorktree: { [wt.id]: [tab] },
      openFiles: [
        {
          id: '/C/file',
          worktreeId: wt.id,
          filePath: '/C/file',
          relativePath: 'file',
          language: 'text',
          isDirty: false
        }
      ],
      groupsByWorktree: {
        [wt.id]: [
          makeTabGroup({
            id: 'C-group',
            worktreeId: wt.id,
            tabOrder: [tab.id],
            activeTabId: tab.id
          })
        ]
      },
      activeGroupIdByWorktree: { [wt.id]: 'C-group' },
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    })
    window.api.repos.add = vi.fn(async () => ({ repo: C }))
    window.api.projectGroups.scanNested = vi.fn(async () => ({
      selectedPath: '/C',
      selectedPathKind: 'non_git_folder',
      repos: [],
      stopped: false,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    }))
    if (!threadRequester) {
      setThreadTestPage({ selection: null })
    }
    render(<Surface />)
    if (threadRequester) {
      const composer = await screen.findByRole('textbox', { name: /Ask for changes/ })
      await waitFor(() => expect(promptEditor(composer)).toBeTruthy())
      act(() => promptEditor(composer).commands.insertContent('P in A'))
      fireEvent.click(screen.getByRole('button', { name: 'Choose project' }))
      fireEvent.click(screen.getByRole('option', { name: 'Add project' }))
    } else {
      act(() => useAppStore.getState().openModal('add-repo'))
    }
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: /Browse folder/ }))
    await screen.findByRole('button', { name: 'Open as Folder' })
    fireEvent.click(screen.getByRole('button', { name: 'Open as Folder' }))
    await waitFor(() => expect(useAppStore.getState().activeWorktreeId).toBe(wt.id))
    expect(useAppStore.getState().getActiveTab(wt.id)?.id).toBe(tab.id)
    expect(screen.getByTestId('page').textContent).toBe('workbench')
  }
)
