// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitBranchChangeEntry, GitCommitCompareResult } from '../../../../shared/types'
import { useGitHistoryCommitActions } from './useGitHistoryCommitActions'

const runtimeMocks = vi.hoisted(() => ({
  getRuntimeGitCommitCompare: vi.fn(),
  getRuntimeGitRemoteCommitFileUrl: vi.fn(),
  getRuntimeGitRemoteCommitUrl: vi.fn()
}))

const { storeMocks, useAppStoreMock } = vi.hoisted(() => {
  const mocks = {
    openCommitAllDiffs: vi.fn(),
    openCommitDiff: vi.fn(),
    createBrowserTab: vi.fn()
  }
  const state = {
    ...mocks,
    settings: {},
    remoteDetectedAgentIds: {},
    detectedAgentIds: [],
    disabledTuiAgents: []
  }
  return {
    storeMocks: mocks,
    useAppStoreMock: Object.assign(
      (selector: (value: typeof state) => unknown) => selector(state),
      { getState: () => state }
    )
  }
})

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => runtimeMocks)
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => 'ssh-1' }))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'typescript' }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))
vi.mock('@/lib/agent-tab-shortcuts', () => ({ resolveDefaultAgentForNewTab: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))
vi.mock('sonner', () => ({ toast: toastMocks }))

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

const item: GitHistoryItem = {
  id: '0123456789abcdef0123456789abcdef01234567',
  parentIds: ['fedcba9876543210fedcba9876543210fedcba98'],
  subject: 'Update source',
  message: 'Update source'
}
const entry: GitBranchChangeEntry = { path: 'src/a.ts', status: 'modified' }
const compareResult = {
  summary: {
    status: 'ready',
    commitOid: item.id,
    parentOid: item.parentIds[0],
    compareRef: item.id,
    baseRef: item.parentIds[0],
    subject: item.subject,
    message: item.message
  },
  entries: [entry]
} as unknown as GitCommitCompareResult

let root: Root | null = null
let latest: ReturnType<typeof useGitHistoryCommitActions> | null = null
const resolveSplitTargetGroupId = vi.fn(() => undefined)

function HookProbe(): null {
  latest = useGitHistoryCommitActions({
    activeWorktreeId: 'wt-1',
    worktreePath: '/repo',
    activeRepoSettings: { activeRuntimeEnvironmentId: null },
    resolveSplitTargetGroupId
  })
  return null
}

async function renderHook(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(HookProbe))
  })
}

async function runFileAction(
  action: Parameters<NonNullable<typeof latest>['handleCommitFileAction']>[0],
  targetItem: GitHistoryItem = item,
  targetEntry: GitBranchChangeEntry = entry
): Promise<void> {
  act(() => latest?.handleCommitFileAction(action, targetItem, targetEntry))
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useGitHistoryCommitActions commit file actions', () => {
  beforeEach(async () => {
    for (const mock of [...Object.values(runtimeMocks), ...Object.values(storeMocks)]) {
      mock.mockReset()
    }
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
    resolveSplitTargetGroupId.mockReset().mockReturnValue(undefined)
    runtimeMocks.getRuntimeGitCommitCompare.mockResolvedValue(compareResult)
    runtimeMocks.getRuntimeGitRemoteCommitFileUrl.mockResolvedValue({
      status: 'ok',
      url: 'https://github.com/org/repo/blob/sha/src/a.ts'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) } }
    })
    await renderHook()
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    latest = null
    document.body.replaceChildren()
  })

  it('opens commit file diffs permanently through the cached commit route', async () => {
    await act(async () => {
      await latest?.loadCommitFiles(item)
    })

    await runFileAction('open-diff')

    expect(storeMocks.openCommitDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo',
      entry,
      expect.objectContaining({ commitOid: item.id, parentOid: item.parentIds[0] }),
      'typescript',
      { targetGroupId: undefined, preview: false }
    )
  })

  it('opens modified files at the selected immutable commit', async () => {
    await runFileAction('open-browser')

    expect(runtimeMocks.getRuntimeGitRemoteCommitFileUrl).toHaveBeenCalledWith(
      {
        settings: { activeRuntimeEnvironmentId: null },
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        connectionId: 'ssh-1'
      },
      { relativePath: entry.path, sha: item.id }
    )
    expect(storeMocks.createBrowserTab).toHaveBeenCalledWith(
      'wt-1',
      'https://github.com/org/repo/blob/sha/src/a.ts',
      { activate: true }
    )
  })

  it('opens deleted files at their first-parent path and ignores root-commit deletions', async () => {
    const deletedEntry: GitBranchChangeEntry = {
      path: 'src/deleted.ts',
      oldPath: 'src/original.ts',
      status: 'deleted'
    }

    await runFileAction('open-browser', item, deletedEntry)
    expect(runtimeMocks.getRuntimeGitRemoteCommitFileUrl).toHaveBeenLastCalledWith(
      expect.any(Object),
      { relativePath: 'src/original.ts', sha: item.parentIds[0] }
    )

    runtimeMocks.getRuntimeGitRemoteCommitFileUrl.mockClear()
    await runFileAction('open-browser', { ...item, parentIds: [] }, deletedEntry)
    expect(runtimeMocks.getRuntimeGitRemoteCommitFileUrl).not.toHaveBeenCalled()
  })

  it('copies only the relative path and full commit hash', async () => {
    await runFileAction('copy-relative-path')
    await runFileAction('copy-commit-hash')

    expect(window.api.ui.writeClipboardText).toHaveBeenNthCalledWith(1, entry.path)
    expect(window.api.ui.writeClipboardText).toHaveBeenNthCalledWith(2, item.id)
    expect(toastMocks.success).toHaveBeenCalledTimes(2)
  })

  it('reports unsupported hosted remotes without opening a tab', async () => {
    runtimeMocks.getRuntimeGitRemoteCommitFileUrl.mockResolvedValue({ status: 'no-remote' })

    await runFileAction('open-browser')

    expect(storeMocks.createBrowserTab).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('This repository has no supported web remote')
  })

  it('reports unpushed commits without opening a tab', async () => {
    runtimeMocks.getRuntimeGitRemoteCommitFileUrl.mockResolvedValue({
      status: 'commit-not-on-remote'
    })

    await runFileAction('open-browser')

    expect(storeMocks.createBrowserTab).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('No remotes found that contain this commit')
  })

  it('reports transport failures while opening commit files', async () => {
    runtimeMocks.getRuntimeGitRemoteCommitFileUrl.mockRejectedValue(new Error('offline'))

    await runFileAction('open-browser')

    expect(storeMocks.createBrowserTab).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to open file in browser')
  })
})
