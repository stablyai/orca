// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'
import { McpConfigSection } from './McpConfigSection'

const runtimeFiles = vi.hoisted(() => ({
  readRuntimeDirectory: vi.fn(),
  readRuntimeFileContent: vi.fn(),
  writeRuntimeFile: vi.fn()
}))
vi.mock('@/runtime/runtime-file-client', () => runtimeFiles)
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const initialState = useAppStore.getInitialState()
const root = '/srv/project'
const worktreeId = `repo::${root}`
const repo: Repo = {
  id: 'repo',
  path: root,
  displayName: 'Project',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'runtime:host-a'
}
const desktopFs = { readDir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  runtimeFiles.readRuntimeDirectory.mockResolvedValue([])
  runtimeFiles.writeRuntimeFile.mockResolvedValue(undefined)
  desktopFs.readDir.mockResolvedValue([{ name: '.mcp.json', isDirectory: false }])
  desktopFs.readFile.mockResolvedValue({ content: '{"mcpServers":{}}', isBinary: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: desktopFs, shell: { pathExists: vi.fn().mockResolvedValue(true) } }
  })
  useAppStore.setState(
    {
      ...initialState,
      // Focus is on the desktop; the selected repo lives on a managed host.
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
      repos: [repo],
      worktreesByRepo: {
        repo: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo',
            path: root,
            isMainWorktree: true,
            hostId: 'runtime:host-a',
            runtimeOwnerEnvironmentId: 'host-a'
          })
        ]
      }
    },
    true
  )
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  Reflect.deleteProperty(window, 'api')
})

it('inspects and creates a managed-host repo config on that host, never the desktop', async () => {
  render(<McpConfigSection repo={repo} />)

  await waitFor(() => expect(runtimeFiles.readRuntimeDirectory).toHaveBeenCalled())
  expect(runtimeFiles.readRuntimeDirectory).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: { activeRuntimeEnvironmentId: 'host-a' },
      worktreeId,
      worktreePath: root
    }),
    root
  )
  expect(desktopFs.readDir).not.toHaveBeenCalled()

  const add = await screen.findByRole('button', { name: /Add MCP config/ })
  fireEvent.click(add)
  fireEvent.click(await screen.findByRole('button', { name: /Create empty config/ }))

  await waitFor(() => expect(runtimeFiles.writeRuntimeFile).toHaveBeenCalled())
  expect(runtimeFiles.writeRuntimeFile).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { activeRuntimeEnvironmentId: 'host-a' } }),
    `${root}/.mcp.json`,
    expect.any(String)
  )
  expect(desktopFs.writeFile).not.toHaveBeenCalled()
})

it('keeps a desktop repo on the desktop while a managed host is focused', async () => {
  const desktopRepo: Repo = { ...repo, executionHostId: 'local' }
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'host-a' },
    repos: [desktopRepo],
    worktreesByRepo: {
      repo: [makeWorktree({ id: worktreeId, repoId: 'repo', path: root, isMainWorktree: true })]
    }
  })
  render(<McpConfigSection repo={desktopRepo} />)

  await waitFor(() => expect(runtimeFiles.readRuntimeDirectory).toHaveBeenCalled())
  expect(runtimeFiles.readRuntimeDirectory).toHaveBeenCalledWith(
    expect.objectContaining({ settings: { activeRuntimeEnvironmentId: null } }),
    root
  )
})

it('does not offer the starter over a listed config the host refuses to read', async () => {
  runtimeFiles.readRuntimeDirectory.mockResolvedValue([{ name: '.mcp.json', isDirectory: false }])
  runtimeFiles.readRuntimeFileContent.mockRejectedValue(new Error('Remote file is too large'))
  render(<McpConfigSection repo={repo} />)

  await screen.findByText('Remote file is too large')
  expect(screen.queryByRole('button', { name: /Add MCP config/ })).toBeNull()
})
