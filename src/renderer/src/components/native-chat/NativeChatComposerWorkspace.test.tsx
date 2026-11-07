// @vitest-environment happy-dom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeWorktree,
  makeFolderWorkspace,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab } from '@/store/slices/store-session-test-harness'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const clipboard = vi.fn(async () => {})
const wt = makeWorktree({
  id: 'wt-1',
  repoId: TEST_REPO.id,
  branch: 'refs/heads/feature/composer',
  hostId: 'local'
})

beforeEach(() => {
  vi.stubGlobal('api', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: clipboard } }
  })
  clipboard.mockClear()
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ machineName: 'My laptop' }),
    runtimeEnvironments: [],
    sshTargetLabels: new Map(),
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [wt] },
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [wt.id]: [makeTab({ id: 'tab-1', worktreeId: wt.id })] },
    unifiedTabsByWorktree: {},
    folderWorkspaces: [],
    structuredSessionLaunchDirectoryByTabId: {},
    activeWorktreeId: wt.id,
    activeWorkspaceExecutionHostId: 'local'
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Footer() {
  return (
    <TooltipProvider>
      <NativeChatComposerWorkspace terminalTabId="tab-1" />
    </TooltipProvider>
  )
}

describe('chat composer workspace', () => {
  it('shows the machine, sidebar checkout name and branch without a separate project label', async () => {
    useAppStore.setState({
      settings: createGlobalSettingsFixture(),
      worktreesByRepo: {
        [TEST_REPO.id]: [{ ...wt, displayName: 'my-checkout', isMainWorktree: true }]
      }
    })
    const getStatus = vi.fn().mockResolvedValue({ machineName: 'Detected laptop' })
    Object.defineProperty(window.api, 'runtime', {
      configurable: true,
      value: { getStatus }
    })
    render(<Footer />)
    const machine = await screen.findByText('Detected laptop')
    const checkout = screen.getByRole('button', { name: 'Copy my-checkout' })
    const branch = screen.getByRole('button', { name: 'Copy feature/composer' })
    expect(
      machine.compareDocumentPosition(checkout) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(checkout.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(checkout)
    expect(clipboard).toHaveBeenCalledWith('my-checkout')
    act(() => checkout.focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(wt.path)
    expect(screen.queryByText(TEST_REPO.displayName)).toBeNull()
    act(() =>
      useAppStore.setState({
        settings: createGlobalSettingsFixture({ machineName: 'Renamed laptop' })
      })
    )
    expect(screen.getByText('Renamed laptop')).toBeTruthy()
  })

  it('shows and copies the current branch, then follows the sidebar identity after checkout', async () => {
    render(<Footer />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy feature/composer' }))
    expect(clipboard).toHaveBeenCalledWith('feature/composer')
    await act(async () => {})
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: 'refs/heads/main' }] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy main' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy feature/composer' })).toBeNull()
  })

  it('shows a legacy chat with an opaque workspace ID before its unified bucket arrives', () => {
    const opaque = makeWorktree({
      id: 'constructor',
      repoId: TEST_REPO.id,
      hostId: 'local',
      path: '/repo/opaque',
      displayName: 'opaque-checkout',
      branch: 'refs/heads/opaque-branch'
    })
    useAppStore.setState({
      worktreesByRepo: { [TEST_REPO.id]: [opaque] },
      tabsByWorktree: { constructor: [makeTab({ id: 'tab-1', worktreeId: opaque.id })] },
      unifiedTabsByWorktree: {}
    })
    render(<Footer />)
    expect(screen.getByRole('button', { name: 'Copy opaque-branch' })).toBeTruthy()
    expect(screen.getByText('opaque-checkout')).toBeTruthy()
  })

  it('copies the full detached HEAD and never invents a branch for a folder', async () => {
    useAppStore.setState({
      worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: '', head: 'a1b2c3d4e5f6' }] }
    })
    render(<Footer />)
    expect(screen.getByRole('button', { name: 'Copy Detached HEAD · a1b2c3d' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy Detached HEAD · a1b2c3d' }))
    expect(clipboard).toHaveBeenCalledWith('a1b2c3d4e5f6')
    await act(async () => {})
    act(() =>
      useAppStore.setState({
        folderWorkspaces: [
          makeFolderWorkspace({
            name: 'notes',
            folderPath: '/work/notes',
            executionHostId: 'local'
          })
        ],
        tabsByWorktree: {
          'folder:folder-1': [makeTab({ id: 'tab-1', worktreeId: 'folder:folder-1' })]
        }
      })
    )
    expect(screen.queryByRole('button', { name: 'Copy Detached HEAD · a1b2c3d' })).toBeNull()
    expect(screen.getByText('notes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy notes' }))
    expect(clipboard).toHaveBeenCalledWith('notes')
  })

  it('identifies a folder project by its checkout name without Git identity', () => {
    const folder = makeWorktree({
      id: 'notes-main',
      repoId: TEST_REPO.id,
      path: '/work/notes',
      displayName: 'plain-notes-folder',
      isMainWorktree: true,
      branch: '',
      head: ''
    })
    useAppStore.setState({
      repos: [{ ...TEST_REPO, kind: 'folder', displayName: 'Notes project', path: '/work/notes' }],
      worktreesByRepo: { [TEST_REPO.id]: [folder] },
      tabsByWorktree: { [folder.id]: [makeTab({ id: 'tab-1', worktreeId: folder.id })] }
    })
    render(<Footer />)
    expect(screen.getByText('plain-notes-folder')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy feature/composer' })).toBeNull()
  })

  it('does not render for unrelated store writes or another workspace branch update', () => {
    const commits = vi.fn()
    render(
      <Profiler id="footer" onRender={commits}>
        <Footer />
      </Profiler>
    )
    commits.mockClear()
    act(() => useAppStore.setState({ activeWorktreeId: 'other' }))
    expect(commits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: {
          [TEST_REPO.id]: [
            wt,
            makeWorktree({ id: 'other', repoId: TEST_REPO.id, branch: 'other-branch' })
          ]
        }
      })
    )
    expect(commits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: 'refs/heads/changed' }] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy changed' })).toBeTruthy()
    expect(commits).toHaveBeenCalledTimes(1)
  })

  it('keeps same-ID host copies separate and leaves the other host unrendered', () => {
    const remote = { ...wt, hostId: 'runtime:box' as const, branch: 'refs/heads/remote-branch' }
    useAppStore.setState({
      runtimeEnvironments: [
        {
          id: 'box',
          name: 'Build Mac',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'direct'
        }
      ],
      repos: [TEST_REPO, { ...TEST_REPO, executionHostId: 'runtime:box' }],
      worktreesByRepo: { [TEST_REPO.id]: [wt, remote] },
      activeWorkspaceExecutionHostId: 'runtime:box'
    })
    const localCommits = vi.fn()
    const remoteCommits = vi.fn()
    render(
      <TooltipProvider>
        <Profiler id="local" onRender={localCommits}>
          <NativeChatComposerWorkspace
            terminalTabId="tab-1"
            structuredTransport={{ worktreeId: wt.id, runtimeEnvironmentId: null }}
          />
        </Profiler>
        <Profiler id="remote" onRender={remoteCommits}>
          <NativeChatComposerWorkspace
            terminalTabId="remote-tab"
            structuredTransport={{ worktreeId: wt.id, runtimeEnvironmentId: 'box' }}
          />
        </Profiler>
      </TooltipProvider>
    )
    expect(screen.getByRole('button', { name: 'Copy feature/composer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy remote-branch' })).toBeTruthy()
    expect(screen.getByText('Build Mac')).toBeTruthy()
    expect(screen.getByText('My laptop')).toBeTruthy()
    localCommits.mockClear()
    remoteCommits.mockClear()
    act(() =>
      useAppStore.getState().setEnvironmentSshConnectionState('box', 'target', {
        targetId: 'target',
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
    )
    expect(localCommits).not.toHaveBeenCalled()
    expect(remoteCommits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.getState().setEnvironmentRemovedSshTargetLabels('other', { target: 'Other box' })
    )
    expect(localCommits).not.toHaveBeenCalled()
    expect(remoteCommits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        runtimeEnvironments: useAppStore.getState().runtimeEnvironments.map((environment) => ({
          ...environment,
          name: 'Renamed server'
        }))
      })
    )
    expect(screen.getByText('Renamed server')).toBeTruthy()
    expect(remoteCommits).toHaveBeenCalledTimes(1)
    expect(localCommits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [wt, { ...remote, branch: 'refs/heads/remote-new' }] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy remote-new' })).toBeTruthy()
    expect(localCommits).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        worktreesByRepo: { [TEST_REPO.id]: [{ ...wt, branch: 'local-new' }, remote] }
      })
    )
    expect(screen.getByRole('button', { name: 'Copy local-new' })).toBeTruthy()
    expect(localCommits).toHaveBeenCalledTimes(1)
  })
})
