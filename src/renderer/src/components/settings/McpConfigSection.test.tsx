// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { MCP_STARTER_CONFIG, PARALLEL_SEARCH_MCP_CONFIG } from '../../../../shared/mcp-config'

const mocks = vi.hoisted(() => ({
  state: {
    activeWorktreeId: null,
    worktreesByRepo: {},
    sshConnectionStates: new Map(),
    openFile: vi.fn(),
    setActiveView: vi.fn(),
    setActiveWorktree: vi.fn(),
    ensureWorktreeRootGroup: vi.fn(() => 'root')
  },
  readDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { McpConfigSection } from './McpConfigSection'

const repo: Repo = {
  id: 'test-repo',
  path: '/test/workspace',
  displayName: 'Test',
  badgeColor: '',
  addedAt: 0
}
const disclosure =
  'When an agent uses these tools, search objectives, queries, and fetched URLs are sent to Parallel. No API key is required.'

async function renderSection(): Promise<void> {
  render(<McpConfigSection repo={repo} />)
  await waitFor(() => expect(mocks.readDir).toHaveBeenCalled())
}

describe('McpConfigSection Parallel preset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readDir.mockResolvedValue([])
    mocks.readFile.mockResolvedValue({ content: MCP_STARTER_CONFIG, isBinary: false })
    mocks.writeFile.mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        shell: { pathExists: vi.fn().mockResolvedValue(true) },
        fs: {
          readDir: mocks.readDir,
          readFile: mocks.readFile,
          writeFile: mocks.writeFile
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows and associates the disclosure before confirmation', async () => {
    await renderSection()
    expect(screen.getByText(disclosure)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add Parallel Search' })).toHaveAccessibleDescription(
      disclosure
    )
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('creates the Parallel preset only after a second click', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add Parallel Search' }))
    expect(mocks.writeFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Parallel Search' }))
    await waitFor(() =>
      expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith({
        filePath: '/test/workspace/.mcp.json',
        content: PARALLEL_SEARCH_MCP_CONFIG,
        connectionId: undefined
      })
    )
  })

  it('lets confirmation expire without writing a config', async () => {
    await renderSection()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Add Parallel Search' }))
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByRole('button', { name: 'Add Parallel Search' })).toBeInTheDocument()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('requires separate confirmation when switching to the neutral starter', async () => {
    await renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Add Parallel Search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP config' }))
    expect(mocks.writeFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Create empty config' }))
    await waitFor(() =>
      expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith({
        filePath: '/test/workspace/.mcp.json',
        content: MCP_STARTER_CONFIG,
        connectionId: undefined
      })
    )
  })

  it('hides both creation actions when an existing config is detected', async () => {
    mocks.readDir.mockResolvedValue([{ name: '.mcp.json', isDirectory: false }])
    await renderSection()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Add Parallel Search' })).not.toBeInTheDocument()
    )
    expect(screen.queryByRole('button', { name: 'Add MCP config' })).not.toBeInTheDocument()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})
