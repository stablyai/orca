/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { useSourceControlStatusRefresh } from './use-status-refresh'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const actions = vi.hoisted(() => ({
  setGitStatus: vi.fn(),
  updateWorktreeGitIdentity: vi.fn(),
  setUpstreamStatus: vi.fn(),
  fetchUpstreamStatus: vi.fn()
}))
const warning = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({
  useAppStore: (select: (state: typeof actions) => unknown) => select(actions)
}))
vi.mock('sonner', () => ({ toast: { warning } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('../../git-status-refresh', () => ({ refreshGitStatusForWorktree: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const findHugeFoldersToIgnore = vi.fn()
const appendGitignore = vi.fn()
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  findHugeFoldersToIgnore.mockReset().mockResolvedValue(['dist'])
  appendGitignore.mockReset().mockResolvedValue(true)
  warning.mockReset()
  vi.stubGlobal('window', {
    ...window,
    api: { git: { findHugeFoldersToIgnore, appendGitignore } }
  })
  container = document.createElement('div')
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container = null
  vi.unstubAllGlobals()
  clearHugeRepoWarningDismissalsForTests()
})

async function renderOwner(
  runtimeEnvironmentId: string | null,
  connectionId: string | null = null
) {
  function Probe() {
    useSourceControlStatusRefresh({
      activeRepoSettings: { activeRuntimeEnvironmentId: runtimeEnvironmentId },
      activeWorktreeId: 'repo::/same/path',
      worktreePath: '/same/path',
      isFolder: false,
      repositoryHuge: { limit: 1000 },
      activeConnectionId: connectionId,
      worktreeMap: new Map()
    })
    return null
  }
  await act(async () => root?.render(<Probe />))
}

it('does not probe or offer a desktop ignore action for a managed owner without a legacy SSH ID', async () => {
  await renderOwner('managed-owner')
  expect(findHugeFoldersToIgnore).not.toHaveBeenCalled()
  expect(warning).not.toHaveBeenCalled()
  expect(appendGitignore).not.toHaveBeenCalled()
})

it('keeps the existing local suggestion', async () => {
  await renderOwner(null)
  expect(findHugeFoldersToIgnore).toHaveBeenCalledExactlyOnceWith({ worktreePath: '/same/path' })
  expect(warning).toHaveBeenCalledTimes(1)
})

it('keeps direct SSH targets out of the desktop helper', async () => {
  await renderOwner(null, 'ssh-owner')
  expect(findHugeFoldersToIgnore).not.toHaveBeenCalled()
  expect(warning).not.toHaveBeenCalled()
})
