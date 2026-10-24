// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { openDetectedFilePath } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, statMock } = doubles

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))

vi.mock('@/store/selectors', () => ({
  selectKnownWorktreeById: (_state: unknown, worktreeId: string) =>
    worktreeId === 'wt-b'
      ? { repoId: 'repo-b', displayName: 'feature-b', branch: '', path: '/b' }
      : null
}))

vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'plaintext' }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
}))

const sourceDeps = { worktreeId: 'wt-a', worktreePath: '/a' }

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  storeState.openFiles = []
  storeState.repos = [{ id: 'repo-b', displayName: 'project-b' }]
  // Records each open as the store does, so the hint sees whether the tab is read-only.
  openFileMock.mockImplementation(
    (file: { filePath: string; worktreeId: string; readOnly?: boolean }) => {
      storeState.openFiles.push({ id: file.filePath, ...file })
    }
  )
  findWorkspaceFileRouteMock.mockReturnValue(null)
  statMock.mockResolvedValue({ isDirectory: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      shell: { openFilePath: vi.fn().mockResolvedValue(true) },
      fs: { stat: statMock, pathExists: vi.fn().mockResolvedValue(true) }
    }
  })
  render(<Toaster />)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('a terminal file link clicked in workspace A', () => {
  it('opens a file inside A in A, with no hint', async () => {
    openDetectedFilePath('/a/src/main.ts', null, null, sourceDeps)
    await settle()

    expect(activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-a', expect.anything())
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/main.ts', worktreeId: 'wt-a' }),
      { forceContentReload: true }
    )
    expect(openFileMock.mock.calls[0][0]).not.toHaveProperty('readOnly')
    expect(screen.queryByText(/This file is in/)).toBeNull()
  })

  it('opens a file workspace B holds in A, and the hint opens it in B', async () => {
    findWorkspaceFileRouteMock.mockReturnValue({
      worktreeId: 'wt-b',
      relativePath: 'report.md',
      executionHostId: 'local'
    })

    openDetectedFilePath('/b/report.md', 7, null, sourceDeps)
    await settle()

    expect(activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-a', expect.anything())
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/b/report.md',
        relativePath: '/b/report.md',
        worktreeId: 'wt-a',
        readOnly: true
      }),
      { forceContentReload: true }
    )
    // Why the project: worktrees of different projects share names like "main".
    expect(screen.getByText('This file is in project-b · feature-b')).not.toBeNull()
    expect(screen.getByText('Opened here as read-only')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open there' }))
    await settle()

    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('wt-b', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
    expect(openFileMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: '/b/report.md',
        relativePath: 'report.md',
        worktreeId: 'wt-b',
        runtimeEnvironmentId: null
      }),
      { forceContentReload: true }
    )
    expect(openFileMock.mock.lastCall?.[0]).not.toHaveProperty('readOnly')
  })

  it('keeps the hint of a second link clicked while the first hint shows', async () => {
    findWorkspaceFileRouteMock.mockReturnValue({
      worktreeId: 'wt-b',
      relativePath: 'report.md',
      executionHostId: 'local'
    })

    openDetectedFilePath('/b/report.md', null, null, sourceDeps)
    await settle()
    findWorkspaceFileRouteMock.mockReturnValue({
      worktreeId: 'wt-b',
      relativePath: 'notes.md',
      executionHostId: 'local'
    })
    openDetectedFilePath('/b/notes.md', 11, null, sourceDeps)
    await settle()
    await act(async () => {
      await vi.advanceTimersToNextFrame()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })

    expect(screen.getByText('This file is in project-b · feature-b')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open there' }))
    await settle()

    expect(openFileMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath: '/b/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-b'
      }),
      { forceContentReload: true }
    )
  })

  it('shows no read-only hint when the link reused an editable tab here', async () => {
    findWorkspaceFileRouteMock.mockReturnValue({
      worktreeId: 'wt-b',
      relativePath: 'report.md',
      executionHostId: 'local'
    })
    openFileMock.mockImplementationOnce(() => {
      storeState.openFiles.push({
        id: '/b/report.md',
        filePath: '/b/report.md',
        worktreeId: 'wt-a'
      })
    })

    openDetectedFilePath('/b/report.md', null, null, sourceDeps)
    await settle()

    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/This file is in/)).toBeNull()
  })
})
