// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  seedRemoteDropWorkspaces,
  RUNTIME_WORKTREE_PATH
} from '@/lib/remote-workspace-drop-test-fixtures'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { useFileExplorerClipboard } from './use-file-explorer-clipboard'

const mocks = vi.hoisted(() => ({
  remoteImport: vi.fn(),
  localImport: vi.fn(),
  error: vi.fn(),
  refresh: vi.fn()
}))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.localImport
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error, loading: vi.fn(), dismiss: vi.fn() } }))

function Explorer({ remote, selected = true }: { remote: boolean; selected?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const worktreeId = remote ? 'wt-runtime' : 'wt-local'
  const worktreePath = remote ? RUNTIME_WORKTREE_PATH : '/local'
  const operationOwner = getFileExplorerOperationOwner(worktreeId)
  const node = {
    name: 'folder',
    path: `${worktreePath}/folder`,
    relativePath: 'folder',
    isDirectory: true,
    depth: 0,
    operationOwner
  }
  useFileExplorerClipboard({
    containerRef,
    worktreeId,
    worktreePath,
    displayRootPath: worktreePath,
    operationOwner,
    selectedPaths: new Set(selected ? [node.path] : []),
    selectedNode: selected ? node : null,
    rowProjection: createFileExplorerRowProjection([node]),
    refreshDir: mocks.refresh
  })
  return (
    <div ref={containerRef}>
      <button data-testid="row">Folder</button>
      <input data-testid="rename" />
    </div>
  )
}

function clipboardEvent(
  target: HTMLElement,
  type: 'copy' | 'paste',
  data: Map<string, string>
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? ''
    }
  })
  act(() => {
    target.focus()
    target.dispatchEvent(event)
  })
  return event
}

beforeEach(() => {
  seedRemoteDropWorkspaces()
  const state = useAppStore.getState()
  useAppStore.setState({
    repos: [
      ...state.repos,
      {
        id: 'repo-local',
        path: '/local',
        displayName: 'local',
        badgeColor: '',
        addedAt: 0,
        connectionId: null,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      ...state.worktreesByRepo,
      'repo-local': [makeWorktree({ id: 'wt-local', repoId: 'repo-local', path: '/local' })]
    }
  })
  replaceRuntimeEnvironmentRevisions([{ id: 'owner-runtime', createdAt: 42 }])
  mocks.remoteImport.mockResolvedValue({
    results: [{ status: 'imported', destPath: '/local/folder' }]
  })
  mocks.localImport.mockResolvedValue({ results: [] })
  mocks.refresh.mockResolvedValue(undefined)
  vi.stubGlobal('api', { fs: { importRuntimeFiles: mocks.remoteImport } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('explorer clipboard ownership', () => {
  it('refuses to recursively copy a local folder into itself', async () => {
    const ui = render(<Explorer remote={false} />)
    const data = new Map<string, string>()
    clipboardEvent(ui.getByTestId('row'), 'copy', data)
    clipboardEvent(ui.getByTestId('row'), 'paste', data)
    await waitFor(() => expect(mocks.error).toHaveBeenCalled())
    expect(mocks.localImport).not.toHaveBeenCalled()
  })

  it('refuses a clipboard whose server pairing changed after copy', async () => {
    const ui = render(<Explorer remote />)
    const data = new Map<string, string>()
    clipboardEvent(ui.getByTestId('row'), 'copy', data)
    replaceRuntimeEnvironmentRevisions([{ id: 'owner-runtime', createdAt: 99 }])
    ui.rerender(<Explorer remote={false} selected={false} />)
    clipboardEvent(ui.getByTestId('row'), 'paste', data)
    await waitFor(() => expect(mocks.error).toHaveBeenCalled())
    expect(mocks.remoteImport).not.toHaveBeenCalled()
  })

  it('keeps the remote source when switching to a local destination', async () => {
    const ui = render(<Explorer remote />)
    const data = new Map<string, string>()
    expect(clipboardEvent(ui.getByTestId('row'), 'copy', data).defaultPrevented).toBe(true)
    ui.rerender(<Explorer remote={false} selected={false} />)
    clipboardEvent(ui.getByTestId('row'), 'paste', data)
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledWith('/local'))
    expect(mocks.remoteImport).toHaveBeenCalledWith({
      environmentId: 'owner-runtime',
      worktree: 'id:wt-runtime',
      relativePaths: ['folder'],
      destinationDir: '/local',
      expectedEnvironmentPairingRevision: 42
    })
    expect(mocks.localImport).not.toHaveBeenCalled()
  })

  it('reuses imports for local files pasted into a remote folder', async () => {
    const ui = render(<Explorer remote={false} />)
    const data = new Map<string, string>()
    clipboardEvent(ui.getByTestId('row'), 'copy', data)
    ui.rerender(<Explorer remote />)
    clipboardEvent(ui.getByTestId('row'), 'paste', data)
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
    expect(mocks.localImport).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'owner-runtime' } }),
      ['/local/folder'],
      `${RUNTIME_WORKTREE_PATH}/folder`,
      expect.any(Object)
    )
  })

  it('leaves text editing and replaced clipboard contents alone', () => {
    const ui = render(<Explorer remote />)
    const data = new Map<string, string>()
    clipboardEvent(ui.getByTestId('row'), 'copy', data)
    expect(clipboardEvent(ui.getByTestId('rename'), 'paste', data).defaultPrevented).toBe(false)
    expect(
      clipboardEvent(ui.getByTestId('row'), 'paste', new Map([['text/plain', 'other text']]))
        .defaultPrevented
    ).toBe(false)
    expect(mocks.remoteImport).not.toHaveBeenCalled()
    expect(mocks.localImport).not.toHaveBeenCalled()
  })
})
