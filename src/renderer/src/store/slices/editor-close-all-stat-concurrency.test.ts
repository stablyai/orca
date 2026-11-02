import type { StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createEditorStore } from './editor-slice-test-harness'

describe('closeAllFiles untitled stat concurrency', () => {
  const runtimeEnvironmentCallMock = vi.fn()
  const runtimeEnvironmentTransportCallMock = vi.fn()

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps remote untitled stats under the runtime pending-request cap', async () => {
    clearRuntimeCompatibilityCacheForTests()
    let inFlight = 0
    let maxInFlight = 0
    let releaseStats: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseStats = resolve
    })
    runtimeEnvironmentCallMock.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method !== 'files.stat') {
        return { ok: true, result: { deleted: true } }
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight -= 1
      return { ok: true, result: { size: 0, isDirectory: false, mtime: 0 } }
    })
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock },
        fs: { deletePath: vi.fn() }
      }
    })
    const store = createEditorStore()
    seedRemoteWorktree(store)
    for (let index = 0; index < 5; index += 1) {
      store.getState().openFile({
        filePath: `/remote/wt/untitled-${index}.md`,
        relativePath: `untitled-${index}.md`,
        worktreeId: 'wt-1',
        language: 'markdown',
        isUntitled: true,
        mode: 'edit'
      })
    }

    store.getState().closeAllFiles()
    await vi.waitFor(() => expect(maxInFlight).toBe(4))
    expect(inFlight).toBe(4)
    releaseStats?.()
    await vi.waitFor(() => expect(inFlight).toBe(0))
  })

  it('records a retained note as soon as its check finishes', async () => {
    clearRuntimeCompatibilityCacheForTests()
    let inFlight = 0
    let slowChecksStarted = 0
    let releaseSlowStats: (() => void) | undefined
    const slowStats = new Promise<void>((resolve) => {
      releaseSlowStats = resolve
    })
    runtimeEnvironmentCallMock.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method !== 'files.stat') {
        return { ok: true, result: { deleted: true } }
      }
      inFlight += 1
      const relativePath = (args.params as { relativePath?: string } | undefined)?.relativePath
      if (relativePath === 'untitled-4.md') {
        inFlight -= 1
        return { ok: true, result: { size: 42, isDirectory: false, mtime: 0 } }
      }
      slowChecksStarted += 1
      await slowStats
      inFlight -= 1
      return { ok: true, result: { size: 0, isDirectory: false, mtime: 0 } }
    })
    runtimeEnvironmentTransportCallMock.mockImplementation(
      (args: RuntimeEnvironmentCallRequest) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
    )
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock },
        fs: { deletePath: vi.fn() }
      }
    })
    const store = createEditorStore()
    seedRemoteWorktree(store)
    for (let index = 0; index < 5; index += 1) {
      store.getState().openFile({
        filePath: `/remote/wt/untitled-${index}.md`,
        relativePath: `untitled-${index}.md`,
        worktreeId: 'wt-1',
        language: 'markdown',
        isUntitled: true,
        mode: 'edit'
      })
    }

    store.getState().closeAllFiles()
    await vi.waitFor(() => expect(slowChecksStarted).toBeGreaterThanOrEqual(3))
    await vi.waitFor(() =>
      expect(
        store
          .getState()
          .recentlyClosedEditorTabsByWorktree['wt-1']?.some(
            (entry) => entry.filePath === '/remote/wt/untitled-4.md'
          )
      ).toBe(true)
    )
    expect(inFlight).toBeGreaterThan(0)

    releaseSlowStats?.()
    await vi.waitFor(() => expect(inFlight).toBe(0))
    expect(
      store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.map((entry) => entry.filePath)
    ).toEqual(['/remote/wt/untitled-4.md'])
  })
})

function seedRemoteWorktree(store: StoreApi<AppState>): void {
  const current = store.getState()
  store.setState({
    settings: { ...current.settings, activeRuntimeEnvironmentId: 'env-1' },
    repos: [
      {
        id: 'repo1',
        path: '/remote/repo',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: {
      repo1: [
        {
          id: 'wt-1',
          repoId: 'repo1',
          path: '/remote/wt',
          branch: 'refs/heads/main',
          head: 'abc',
          isBare: false,
          isMainWorktree: false,
          displayName: 'main',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0
        }
      ]
    }
  })
}
