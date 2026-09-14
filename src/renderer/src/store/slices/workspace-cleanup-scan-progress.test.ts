import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  WORKTREE_ID,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'
import { WorkspaceCleanupScanSupersededError } from './workspace-cleanup-broad-scan-registry'

describe('workspace cleanup scan progress', () => {
  it('joins duplicate broad cleanup scans', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn().mockReturnValue(pending.promise)
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const first = store.getState().scanWorkspaceCleanup()
    const second = store.getState().scanWorkspaceCleanup()

    expect(scan).toHaveBeenCalledTimes(1)
    expect(store.getState().workspaceCleanupLoading).toBe(true)

    const result = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    pending.resolve(result)

    await expect(Promise.all([first, second])).resolves.toEqual([result, result])
    expect(store.getState().workspaceCleanupScan?.candidates).toHaveLength(1)
    expect(store.getState().workspaceCleanupLoading).toBe(false)
  })

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

  it('shows scanned cleanup candidates before the final broad scan resolves', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const partialCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/partial' })
    const finalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/final' })
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
      candidates: [partialCandidate],
      errors: []
    })

    expect(store.getState().workspaceCleanupLoading).toBe(true)
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress).toMatchObject({
        scannedWorktreeCount: 1,
        totalWorktreeCount: 2
      })
    })
    expect(store.getState().workspaceCleanupScan?.candidates).toEqual([partialCandidate])

    pending.resolve({
      scannedAt: NOW,
      candidates: [partialCandidate, finalCandidate],
      errors: []
    })

    await expect(scanPromise).resolves.toEqual({
      scannedAt: NOW,
      candidates: [partialCandidate, finalCandidate],
      errors: []
    })
    expect(store.getState().workspaceCleanupLoading).toBe(false)
    expect(store.getState().workspaceCleanupProgress).toMatchObject({
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2
    })
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

  it('does not re-probe previously enriched rows during cumulative progress updates', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const terminalCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/terminal' })
    const laterCandidate = makeCandidate({ worktreeId: 'repo1::/tmp/later' })
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan)
    const hasChildProcesses = vi.fn().mockResolvedValue(false)
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
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(1)
    })
    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2,
      candidates: [laterCandidate],
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(2)
    })
    expect(store.getState().workspaceCleanupScan?.candidates).toHaveLength(2)
    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)

    pending.resolve({
      scannedAt: NOW,
      candidates: [terminalCandidate, laterCandidate],
      errors: []
    })
    await scanPromise

    expect(hasChildProcesses).toHaveBeenCalledTimes(1)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
  })

  it('updates count-only append progress without replacing existing candidate rows', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const candidate = makeCandidate({ worktreeId: 'repo1::/tmp/alpha' })
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
      candidates: [candidate],
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(1)
    })
    const candidatesAfterFirstAppend = store.getState().workspaceCleanupScan?.candidates

    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2,
      candidates: [],
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(2)
    })
    expect(store.getState().workspaceCleanupScan?.candidates).toBe(candidatesAfterFirstAppend)

    pending.resolve({
      scannedAt: NOW,
      candidates: [candidate],
      errors: []
    })
    await scanPromise
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
    // Why: the first fleet scan was superseded when the second started.
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

  it('does not join broad cleanup scans with different explicit args', async () => {
    const firstPending = deferred<WorkspaceCleanupScanResult>()
    const secondPending = deferred<WorkspaceCleanupScanResult>()
    const firstResult = {
      scannedAt: NOW,
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/first' })],
      errors: []
    }
    const secondResult = {
      scannedAt: NOW + 1,
      candidates: [makeCandidate({ worktreeId: 'repo1::/tmp/second' })],
      errors: []
    }
    const scan = vi.fn((args?: { skipGitWorktreeIds?: string[] }) =>
      args?.skipGitWorktreeIds?.includes('repo1::/tmp/first')
        ? firstPending.promise
        : secondPending.promise
    )
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const first = store
      .getState()
      .scanWorkspaceCleanup({ skipGitWorktreeIds: ['repo1::/tmp/first'] })
    const second = store
      .getState()
      .scanWorkspaceCleanup({ skipGitWorktreeIds: ['repo1::/tmp/second'] })

    expect(scan).toHaveBeenCalledTimes(2)
    secondPending.resolve(secondResult)
    await second
    expect(store.getState().workspaceCleanupScan).toMatchObject(secondResult)

    // Why: the first fleet scan was superseded when the second started — its
    // late settlement must neither surface nor clobber the newer result.
    firstPending.resolve(firstResult)
    await expect(first).rejects.toBeInstanceOf(WorkspaceCleanupScanSupersededError)
    expect(store.getState().workspaceCleanupScan).toMatchObject(secondResult)
  })

  it('does not join suggestion-only and full-workspace broad scans', async () => {
    const legacyPending = deferred<WorkspaceCleanupScanResult>()
    const fullPending = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn((args?: { includeAllWorkspaces?: boolean }) =>
      args?.includeAllWorkspaces ? fullPending.promise : legacyPending.promise
    )
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const legacy = store.getState().scanWorkspaceCleanup({ includeAllWorkspaces: false })
    const full = store.getState().scanWorkspaceCleanup({ includeAllWorkspaces: true })

    expect(scan).toHaveBeenCalledTimes(2)
    fullPending.resolve({ scannedAt: NOW, candidates: [], errors: [] })
    legacyPending.resolve({ scannedAt: NOW - 1, candidates: [], errors: [] })
    await expect(Promise.all([legacy, full])).resolves.toHaveLength(2)
  })

  it('restarts a superseded key instead of joining the cancelled scan', async () => {
    const firstPending = deferred<WorkspaceCleanupScanResult>()
    const secondPending = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn((args?: { skipGitWorktreeIds?: string[] }) =>
      args?.skipGitWorktreeIds?.includes('second') ? secondPending.promise : firstPending.promise
    )
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const first = store.getState().scanWorkspaceCleanup({ skipGitWorktreeIds: ['first'] })
    const second = store.getState().scanWorkspaceCleanup({ skipGitWorktreeIds: ['second'] })
    const firstAgain = store.getState().scanWorkspaceCleanup({ skipGitWorktreeIds: ['first'] })

    // Why: each new fleet scan supersedes the previous one — only the latest
    // request may run, and a re-issued key starts fresh rather than joining
    // the cancelled scan.
    expect(scan).toHaveBeenCalledTimes(3)
    firstPending.resolve({ scannedAt: NOW, candidates: [], errors: [] })
    secondPending.resolve({ scannedAt: NOW, candidates: [], errors: [] })
    await expect(first).rejects.toBeInstanceOf(WorkspaceCleanupScanSupersededError)
    await expect(second).rejects.toBeInstanceOf(WorkspaceCleanupScanSupersededError)
    await expect(firstAgain).resolves.toMatchObject({ scannedAt: NOW })
  })

  it('keeps stale cleanup results visible after a broad refresh failure', async () => {
    const previous = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    const scan = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error('scan failed'))
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    await store.getState().scanWorkspaceCleanup()
    await expect(store.getState().scanWorkspaceCleanup()).rejects.toThrow('scan failed')

    expect(store.getState().workspaceCleanupScan).toMatchObject(previous)
    expect(store.getState().workspaceCleanupError).toBe('scan failed')
    expect(store.getState().workspaceCleanupLoading).toBe(false)
  })

  it('keeps focused cleanup preflight scans separate from broad scans', async () => {
    const broad = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn((args?: { worktreeId?: string }) => {
      if (args?.worktreeId) {
        return Promise.resolve({
          scannedAt: NOW + 1,
          candidates: [makeCandidate({ worktreeId: args.worktreeId })],
          errors: []
        } satisfies WorkspaceCleanupScanResult)
      }
      return broad.promise
    })
    installWorkspaceCleanupApi(scan)
    const store = createCleanupTestStore()

    const broadScan = store.getState().scanWorkspaceCleanup()
    const focusedScan = await store.getState().scanWorkspaceCleanup({ worktreeId: WORKTREE_ID })

    expect(scan).toHaveBeenCalledTimes(2)
    expect(focusedScan.candidates[0]?.worktreeId).toBe(WORKTREE_ID)
    expect(store.getState().workspaceCleanupScan).toBeNull()

    broad.resolve({ scannedAt: NOW, candidates: [], errors: [] })
    await broadScan
    expect(store.getState().workspaceCleanupScan?.scannedAt).toBe(NOW)
  })
})
