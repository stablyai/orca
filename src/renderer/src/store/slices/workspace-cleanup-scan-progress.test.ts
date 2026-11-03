import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'
import { WorkspaceCleanupScanSupersededError } from './workspace-cleanup-broad-scan-registry'

describe('workspace cleanup scan progress', () => {
  it('does not leave cleanup loading stuck when a reopen joins a just-settled scan', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    const result = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    const scan = vi.fn().mockReturnValue(pending.promise)
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()
    let joinedScan: Promise<WorkspaceCleanupScanResult> | null = null

    const unsubscribe = store.subscribe((state, previousState) => {
      if (
        previousState.workspaceCleanupLoading &&
        !state.workspaceCleanupLoading &&
        joinedScan === null
      ) {
        joinedScan = state.scanWorkspaceCleanup()
      }
    })

    const firstScan = store.getState().scanWorkspaceCleanup()
    pending.resolve(result)

    await expect(firstScan).resolves.toEqual(result)
    await expect(joinedScan).resolves.toEqual(result)
    unsubscribe()

    expect(scan).toHaveBeenCalledTimes(1)
    expect(store.getState().workspaceCleanupLoading).toBe(false)
  })

  it('keeps same-id host rows distinct across streamed enrichment frames', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const localCandidate = makeCandidate({ executionHostId: 'local' })
    const remoteCandidate = makeCandidate({ executionHostId: 'ssh:ssh-1', connectionId: 'ssh-1' })
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 2,
      candidates: [localCandidate],
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(1)
    })

    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2,
      candidates: [remoteCandidate],
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupScan?.candidates).toHaveLength(2)
    })

    pending.resolve({ scannedAt: NOW, candidates: [localCandidate, remoteCandidate], errors: [] })
    await scanPromise

    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([
      expect.objectContaining({ executionHostId: 'local' }),
      expect.objectContaining({ executionHostId: 'ssh:ssh-1' })
    ])
  })

  it('keeps append progress rows when terminal enrichment resolves out of order', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    const terminalProbe = deferred<boolean>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const terminalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/terminal' })
    const laterCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/later' })
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan)
    const hasChildProcesses = vi.fn().mockReturnValue(terminalProbe.promise)
    const getForegroundProcess = vi.fn().mockResolvedValue('zsh')
    ;(
      globalThis.window as unknown as {
        api: {
          pty?: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: typeof getForegroundProcess
          }
        }
      }
    ).api.pty = { hasChildProcesses, getForegroundProcess }
    const store = createCleanupTestStore()
    store.setState({
      tabsByWorktree: {
        'repo1::/tmp/terminal': [
          { id: 'tab-1', title: 'zsh' }
        ] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState>)

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 2,
      candidates: [terminalCandidate],
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    })

    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2,
      candidates: [laterCandidate],
      errors: [],
      candidateMode: 'append'
    })
    await Promise.resolve()
    expect(store.getState().workspaceCleanupProgress).toBeNull()

    terminalProbe.resolve(false)
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(2)
    })
    expect(
      store.getState().workspaceCleanupScan?.candidates.map((candidate) => candidate.worktreeId)
    ).toEqual(['repo1::/tmp/terminal', 'repo1::/tmp/later'])

    pending.resolve({
      scannedAt: NOW,
      candidates: [terminalCandidate, laterCandidate],
      errors: []
    })
    await scanPromise
  })

  it('drains queued progress before publishing the final scan result', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    const terminalProbe = deferred<boolean>()
    let scanSettled = false
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const terminalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/terminal' })
    const finalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/final' })
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan)
    const hasChildProcesses = vi.fn().mockReturnValue(terminalProbe.promise)
    const getForegroundProcess = vi.fn().mockResolvedValue('zsh')
    ;(
      globalThis.window as unknown as {
        api: {
          pty?: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: typeof getForegroundProcess
          }
        }
      }
    ).api.pty = { hasChildProcesses, getForegroundProcess }
    const store = createCleanupTestStore()
    store.setState({
      tabsByWorktree: {
        'repo1::/tmp/terminal': [
          { id: 'tab-1', title: 'zsh' }
        ] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState>)

    const scanPromise = store
      .getState()
      .scanWorkspaceCleanup()
      .finally(() => {
        scanSettled = true
      })
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 2,
      candidates: [terminalCandidate],
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    })

    pending.resolve({
      scannedAt: NOW,
      candidates: [finalCandidate],
      errors: []
    })
    await Promise.resolve()
    expect(scanSettled).toBe(false)

    terminalProbe.resolve(false)
    await scanPromise
    expect(scanSettled).toBe(true)

    expect(
      store.getState().workspaceCleanupScan?.candidates.map((candidate) => candidate.worktreeId)
    ).toEqual(['repo1::/tmp/final'])
    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(store.getState().workspaceCleanupProgress).toMatchObject({
      scannedWorktreeCount: 1,
      totalWorktreeCount: 1
    })
  })

  it('ignores stale progress without replacing the active scan progress queue', async () => {
    const firstPending = deferred<WorkspaceCleanupScanResult>()
    const secondPending = deferred<WorkspaceCleanupScanResult>()
    const terminalProbe = deferred<boolean>()
    const progressCallbacks: ((progress: WorkspaceCleanupScanProgress) => void)[] = []
    let secondScanSettled = false
    const firstCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/first' })
    const terminalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/terminal' })
    const finalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/final' })
    const scan = vi.fn((args, progressCallback) => {
      progressCallbacks.push(progressCallback)
      return args?.skipGitWorktreeIds?.includes('second')
        ? secondPending.promise
        : firstPending.promise
    })
    installWorkspaceCleanupApi(scan)
    const hasChildProcesses = vi.fn().mockReturnValue(terminalProbe.promise)
    const getForegroundProcess = vi.fn().mockResolvedValue('zsh')
    ;(
      globalThis.window as unknown as {
        api: {
          pty?: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: typeof getForegroundProcess
          }
        }
      }
    ).api.pty = { hasChildProcesses, getForegroundProcess }
    const store = createCleanupTestStore()
    store.setState({
      tabsByWorktree: {
        'repo1::/tmp/terminal': [
          { id: 'tab-1', title: 'zsh' }
        ] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    } as Partial<AppState>)

    const firstScan = store.getState().scanWorkspaceCleanup({ skipGitWorktreeIds: ['first'] })
    const secondScan = store
      .getState()
      .scanWorkspaceCleanup({ skipGitWorktreeIds: ['second'] })
      .finally(() => {
        secondScanSettled = true
      })

    progressCallbacks[1]?.({
      scanId: 'scan-2',
      scannedAt: NOW,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 2,
      candidates: [terminalCandidate],
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    })
    progressCallbacks[0]?.({
      scanId: 'scan-1',
      scannedAt: NOW - 1,
      scannedWorktreeCount: 1,
      totalWorktreeCount: 1,
      candidates: [firstCandidate],
      errors: [],
      candidateMode: 'append'
    })

    secondPending.resolve({
      scannedAt: NOW,
      candidates: [terminalCandidate, finalCandidate],
      errors: []
    })
    await Promise.resolve()
    expect(secondScanSettled).toBe(false)

    terminalProbe.resolve(false)
    await secondScan
    firstPending.resolve({ scannedAt: NOW - 1, candidates: [firstCandidate], errors: [] })
    await expect(firstScan).rejects.toBeInstanceOf(WorkspaceCleanupScanSupersededError)

    expect(
      store.getState().workspaceCleanupScan?.candidates.map((candidate) => candidate.worktreeId)
    ).toEqual(['repo1::/tmp/terminal', 'repo1::/tmp/final'])
  })

  it('does not let an in-flight broad scan revive removed cleanup rows', async () => {
    const firstBroadScan = deferred<WorkspaceCleanupScanResult>()
    const secondBroadScan = deferred<WorkspaceCleanupScanResult>()
    const candidate = makeCandidate()
    const refreshedCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/refreshed' })
    const broadScans = [firstBroadScan, secondBroadScan]
    const scan = vi.fn((args?: WorkspaceCleanupScanArgs) => {
      if (args?.worktreeId || args?.worktreeIds) {
        return Promise.resolve({ scannedAt: NOW, candidates: [candidate], errors: [] })
      }
      const nextBroadScan = broadScans.shift()
      if (!nextBroadScan) {
        throw new Error('unexpected broad scan')
      }
      return nextBroadScan.promise
    })
    installWorkspaceCleanupApi(scan)
    const cancelScan = vi.fn(async () => {
      firstBroadScan.reject(new Error('Workspace cleanup scan cancelled'))
      return true
    })
    ;(
      globalThis.window as unknown as {
        api: { workspaceCleanup: { cancelScan: typeof cancelScan } }
      }
    ).api.workspaceCleanup.cancelScan = cancelScan
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)
    store.setState({
      workspaceCleanupScan: { scannedAt: NOW - 1, candidates: [candidate], errors: [] }
    } as Partial<AppState>)

    const pendingRefresh = store.getState().scanWorkspaceCleanup()
    const firstBroadScanId = scan.mock.calls[0]?.[0]?.scanId
    await store.getState().removeWorkspaceCleanupCandidates([candidate.worktreeId])
    const replacementRefresh = store.getState().scanWorkspaceCleanup()

    expect(scan).toHaveBeenCalledTimes(3)
    expect(cancelScan).toHaveBeenCalledExactlyOnceWith(firstBroadScanId)

    secondBroadScan.resolve({ scannedAt: NOW, candidates: [refreshedCandidate], errors: [] })
    await expect(replacementRefresh).resolves.toMatchObject({
      candidates: [refreshedCandidate]
    })

    await expect(pendingRefresh).rejects.toBeInstanceOf(WorkspaceCleanupScanSupersededError)

    expect(store.getState().workspaceCleanupLoading).toBe(false)
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([refreshedCandidate])
  })
})
