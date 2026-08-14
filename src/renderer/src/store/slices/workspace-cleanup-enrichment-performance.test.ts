import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY } from './workspace-cleanup'
import {
  NOW,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

type GlobalCollectionScanCounts = {
  openFiles: number
  retainedAgents: number
  agentStatuses: number
}

const ALPHA_ID = 'repo-alpha::/workspace/alpha'
const BETA_ID = 'repo-beta::/workspace/beta'
const PROJECTION_CANDIDATE_COUNT = 1_000

function countOpenFileScans(
  openFiles: AppState['openFiles'],
  counts: GlobalCollectionScanCounts
): AppState['openFiles'] {
  return new Proxy(openFiles, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return () => {
          counts.openFiles += 1
          return target[Symbol.iterator]()
        }
      }
      if (property === 'filter') {
        return (predicate: (file: AppState['openFiles'][number]) => boolean) => {
          counts.openFiles += 1
          return target.filter(predicate)
        }
      }
      return Reflect.get(target, property, receiver)
    }
  })
}

function countRecordScans<T extends object>(record: T, onScan: () => void): T {
  return new Proxy(record, {
    ownKeys(target) {
      onScan()
      return Reflect.ownKeys(target)
    }
  })
}

function resetGlobalCollectionScanCounts(counts: GlobalCollectionScanCounts): void {
  counts.openFiles = 0
  counts.retainedAgents = 0
  counts.agentStatuses = 0
}

function makePerformanceCandidate(index: number, fingerprintSuffix = 'stream') {
  return makeCandidate({
    worktreeId: `repo-${index}::/workspace/${index}`,
    repoId: `repo-${index}`,
    displayName: `workspace-${index}`,
    path: `/workspace/${index}`,
    fingerprint: `fingerprint-${index}-${fingerprintSuffix}`
  })
}

describe('workspace cleanup enrichment performance', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scans global collections once per progress and final pass without changing results', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const scan = vi.fn(
      (
        _args?: WorkspaceCleanupScanArgs,
        progressCallback?: (progress: WorkspaceCleanupScanProgress) => void
      ) => {
        onProgress = progressCallback
        return pending.promise
      }
    )
    installWorkspaceCleanupApi(scan)

    const alphaTab = { id: 'tab-alpha', title: 'shell' }
    const betaTab = { id: 'tab-beta', title: 'shell' }
    const alphaWorking = {
      paneKey: 'tab-alpha:leaf-alpha',
      state: 'working',
      prompt: '',
      updatedAt: NOW,
      stateStartedAt: NOW,
      stateHistory: []
    }
    const betaDone = {
      paneKey: 'tab-beta:leaf-beta',
      state: 'done',
      prompt: '',
      updatedAt: NOW,
      stateStartedAt: NOW,
      stateHistory: []
    }
    const counts: GlobalCollectionScanCounts = {
      openFiles: 0,
      retainedAgents: 0,
      agentStatuses: 0
    }
    const openFiles = countOpenFileScans(
      [
        {
          id: 'alpha-dirty',
          worktreeId: ALPHA_ID,
          filePath: '/workspace/alpha/dirty.ts',
          relativePath: 'dirty.ts',
          language: 'typescript',
          isDirty: true
        },
        {
          id: 'alpha-clean',
          worktreeId: ALPHA_ID,
          filePath: '/workspace/alpha/clean.ts',
          relativePath: 'clean.ts',
          language: 'typescript',
          isDirty: false
        },
        {
          id: 'beta-clean',
          worktreeId: BETA_ID,
          filePath: '/workspace/beta/clean.ts',
          relativePath: 'clean.ts',
          language: 'typescript',
          isDirty: false
        }
      ] as AppState['openFiles'],
      counts
    )
    const retainedAgentsByPaneKey = countRecordScans(
      {
        'tab-alpha:retained': {
          entry: { ...alphaWorking, paneKey: 'tab-alpha:retained', state: 'done' },
          worktreeId: ALPHA_ID,
          tab: alphaTab,
          agentType: 'codex',
          startedAt: NOW
        },
        'tab-beta:retained': {
          entry: { ...betaDone, paneKey: 'tab-beta:retained', state: 'working' },
          worktreeId: BETA_ID,
          tab: betaTab,
          agentType: 'codex',
          startedAt: NOW
        }
      } as unknown as AppState['retainedAgentsByPaneKey'],
      () => {
        counts.retainedAgents += 1
      }
    )
    const agentStatusByPaneKey = countRecordScans(
      {
        [alphaWorking.paneKey]: alphaWorking,
        [betaDone.paneKey]: betaDone
      } as AppState['agentStatusByPaneKey'],
      () => {
        counts.agentStatuses += 1
      }
    )
    const candidates = [
      makeCandidate({
        worktreeId: ALPHA_ID,
        repoId: 'repo-alpha',
        displayName: 'alpha',
        path: '/workspace/alpha',
        blockers: ['dismissed'],
        fingerprint: 'alpha-fingerprint'
      }),
      makeCandidate({
        worktreeId: BETA_ID,
        repoId: 'repo-beta',
        displayName: 'beta',
        path: '/workspace/beta',
        fingerprint: 'beta-fingerprint'
      }),
      ...Array.from({ length: PROJECTION_CANDIDATE_COUNT - 2 }, (_, index) =>
        makePerformanceCandidate(index + 2, 'projection')
      )
    ]
    const tabsByWorktree = Object.fromEntries(
      candidates.map((candidate, index) => {
        if (index === 0) {
          return [candidate.worktreeId, [alphaTab]]
        }
        if (index === 1) {
          return [candidate.worktreeId, [betaTab]]
        }
        return [candidate.worktreeId, [{ id: `tab-projection-${index}`, title: 'shell' }]]
      })
    ) as unknown as AppState['tabsByWorktree']
    const store = createCleanupTestStore()
    store.setState({
      activeWorktreeId: BETA_ID,
      tabsByWorktree,
      openFiles,
      browserTabsByWorktree: {
        [ALPHA_ID]: [{}]
      } as unknown as AppState['browserTabsByWorktree'],
      retainedAgentsByPaneKey,
      agentStatusByPaneKey,
      lastVisitedAtByWorktreeId: { [ALPHA_ID]: NOW - 1 }
    } as Partial<AppState>)

    const scanPromise = store.getState().scanWorkspaceCleanup()
    expect(counts).toEqual({ openFiles: 1, retainedAgents: 0, agentStatuses: 1 })
    resetGlobalCollectionScanCounts(counts)
    onProgress?.({
      scanId: 'performance-scan',
      scannedAt: NOW,
      scannedWorktreeCount: candidates.length,
      totalWorktreeCount: candidates.length,
      candidates,
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(
        candidates.length
      )
    })
    expect(counts).toEqual({ openFiles: 1, retainedAgents: 1, agentStatuses: 1 })
    const progressCandidates = store.getState().workspaceCleanupScan?.candidates
    expect(progressCandidates?.[0]).toMatchObject({
      blockers: ['dirty-editor-buffer', 'live-agent', 'recent-visible-context'],
      localContext: {
        terminalTabCount: 1,
        cleanEditorTabCount: 1,
        browserTabCount: 1,
        retainedDoneAgentCount: 1
      }
    })
    expect(progressCandidates?.[1]).toMatchObject({
      blockers: ['active-workspace'],
      localContext: {
        terminalTabCount: 1,
        cleanEditorTabCount: 1,
        browserTabCount: 0,
        retainedDoneAgentCount: 0
      }
    })

    resetGlobalCollectionScanCounts(counts)
    pending.resolve({ scannedAt: NOW, candidates, errors: [] })
    const finalScan = await scanPromise

    expect(counts).toEqual({ openFiles: 1, retainedAgents: 1, agentStatuses: 1 })
    expect(finalScan.candidates).toEqual(progressCandidates)
  })

  it('caps terminal candidate probes for streamed and final enrichment', async () => {
    const candidateCount = WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY + 3
    const streamCandidates = Array.from({ length: candidateCount }, (_, index) =>
      makePerformanceCandidate(index)
    )
    const finalCandidates = streamCandidates.map((candidate, index) => ({
      ...candidate,
      fingerprint: `fingerprint-${index}-final`
    }))
    const tabsByWorktree = Object.fromEntries(
      streamCandidates.map((candidate, index) => [
        candidate.worktreeId,
        [{ id: `tab-${index}`, title: 'shell' }]
      ])
    ) as AppState['tabsByWorktree']
    const ptyIdsByTabId = Object.fromEntries(
      streamCandidates.map((_, index) => [`tab-${index}`, [`pty-${index}`]])
    )
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const scan = vi.fn(
      (
        _args?: WorkspaceCleanupScanArgs,
        progressCallback?: (progress: WorkspaceCleanupScanProgress) => void
      ) => {
        onProgress = progressCallback
        return pending.promise
      }
    )
    installWorkspaceCleanupApi(scan)

    type ProbePhase = 'stream' | 'final'
    let phase: ProbePhase = 'stream'
    let probeGate = deferred<void>()
    const active: Record<ProbePhase, number> = { stream: 0, final: 0 }
    const peak: Record<ProbePhase, number> = { stream: 0, final: 0 }
    const hasChildProcesses = vi.fn(async () => {
      const callPhase = phase
      const callGate = probeGate
      active[callPhase] += 1
      peak[callPhase] = Math.max(peak[callPhase], active[callPhase])
      await callGate.promise
      active[callPhase] -= 1
      return false
    })
    ;(
      globalThis.window as unknown as {
        api: {
          pty: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.pty = {
      hasChildProcesses,
      getForegroundProcess: vi.fn().mockResolvedValue('zsh')
    }
    const store = createCleanupTestStore()
    store.setState({ tabsByWorktree, ptyIdsByTabId } as Partial<AppState>)

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'bounded-scan',
      scannedAt: NOW,
      scannedWorktreeCount: candidateCount,
      totalWorktreeCount: candidateCount,
      candidates: streamCandidates,
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(active.stream).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)
    })
    probeGate.resolve()
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(candidateCount)
    })
    expect(peak.stream).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)

    phase = 'final'
    probeGate = deferred<void>()
    pending.resolve({ scannedAt: NOW, candidates: finalCandidates, errors: [] })
    await vi.waitFor(() => {
      expect(active.final).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)
    })
    probeGate.resolve()
    const finalScan = await scanPromise

    expect(peak.final).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)
    expect(hasChildProcesses).toHaveBeenCalledTimes(candidateCount * 2)
    expect(finalScan.candidates.map((candidate) => candidate.worktreeId)).toEqual(
      finalCandidates.map((candidate) => candidate.worktreeId)
    )
  })

  it('drains streamed enrichment before projecting the final scan', async () => {
    const candidateCount = WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY + 3
    const candidates = Array.from({ length: candidateCount }, (_, index) =>
      makePerformanceCandidate(index)
    )
    const tabsByWorktree = Object.fromEntries(
      candidates.map((candidate, index) => [
        candidate.worktreeId,
        [{ id: `tab-overlap-${index}`, title: 'shell' }]
      ])
    ) as AppState['tabsByWorktree']
    const ptyIdsByTabId = Object.fromEntries(
      candidates.map((_, index) => [`tab-overlap-${index}`, [`pty-overlap-${index}`]])
    )
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    installWorkspaceCleanupApi(
      vi.fn(
        (
          _args?: WorkspaceCleanupScanArgs,
          progressCallback?: (progress: WorkspaceCleanupScanProgress) => void
        ) => {
          onProgress = progressCallback
          return pending.promise
        }
      )
    )

    const probeGate = deferred<void>()
    let active = 0
    let peak = 0
    const hasChildProcesses = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await probeGate.promise
      active -= 1
      return false
    })
    ;(
      globalThis.window as unknown as {
        api: {
          pty: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.pty = {
      hasChildProcesses,
      getForegroundProcess: vi.fn().mockResolvedValue('zsh')
    }
    const store = createCleanupTestStore()
    store.setState({ tabsByWorktree, ptyIdsByTabId } as Partial<AppState>)

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'overlapping-final-scan',
      scannedAt: NOW,
      scannedWorktreeCount: candidateCount,
      totalWorktreeCount: candidateCount,
      candidates,
      errors: [],
      candidateMode: 'append'
    })
    pending.resolve({ scannedAt: NOW, candidates, errors: [] })

    await vi.waitFor(() => {
      expect(active).toBeGreaterThanOrEqual(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)

    probeGate.resolve()
    await scanPromise

    expect(hasChildProcesses).toHaveBeenCalledTimes(candidateCount)
  })

  it('rebuilds focused removal enrichment from state changed after the broad scan', async () => {
    const candidate = makeCandidate()
    const focusedScan = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn((args?: WorkspaceCleanupScanArgs) =>
      args?.worktreeId
        ? focusedScan.promise
        : Promise.resolve({ scannedAt: NOW, candidates: [candidate], errors: [] })
    )
    installWorkspaceCleanupApi(scan)
    const hasChildProcesses = vi.fn().mockResolvedValue(false)
    ;(
      globalThis.window as unknown as {
        api: {
          pty: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.pty = {
      hasChildProcesses,
      getForegroundProcess: vi.fn().mockResolvedValue('zsh')
    }
    const removeWorktree = vi.fn().mockResolvedValue({ ok: true })
    const store = createCleanupTestStore(removeWorktree)

    await store.getState().scanWorkspaceCleanup()
    const removal = store.getState().removeWorkspaceCleanupCandidates([candidate.worktreeId])
    store.setState({
      tabsByWorktree: {
        [candidate.worktreeId]: [
          { id: 'post-scan-tab', title: 'shell' }
        ] as AppState['tabsByWorktree'][string]
      },
      ptyIdsByTabId: { 'post-scan-tab': ['post-scan-pty'] }
    } as Partial<AppState>)
    focusedScan.resolve({ scannedAt: NOW, candidates: [candidate], errors: [] })

    await expect(removal).resolves.toMatchObject({ removedIds: [candidate.worktreeId] })
    expect(hasChildProcesses).toHaveBeenCalledWith('post-scan-pty')
  })
})
