import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { readNativeDetectedAgents } from './local-detected-agent-store-state'
import { createDetectedAgentsSlice } from './detected-agents'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()

globalThis.window = {
  api: {
    preflight: { detectAgents, refreshAgents },
    platform: { get: () => ({ platform: 'win32' }) }
  } as unknown as Window['api']
} as Window & typeof globalThis

function makeRepo(id: string): Repo {
  return {
    id,
    path: `C:\\${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0
  }
}

function createTestStore(repos: Repo[]) {
  const store = create<AppState>()(
    (...args) => createDetectedAgentsSlice(...args) as unknown as AppState
  )
  store.setState({
    repos,
    projects: repos.map((repo) => ({
      id: repo.id,
      displayName: repo.displayName,
      badgeColor: repo.badgeColor,
      sourceRepoIds: [repo.id],
      createdAt: 0,
      updatedAt: 0,
      localWindowsRuntimePreference: { kind: 'wsl' as const, distro: 'Ubuntu' }
    })),
    settings: {
      ...getDefaultSettings('/tmp'),
      localWindowsRuntimeDefault: { kind: 'windows-host' }
    },
    worktreesByRepo: {},
    activeRepoId: repos[0]?.id ?? null,
    activeWorktreeId: null
  })
  return store
}

describe('local detected agent context lifecycle', () => {
  beforeEach(() => {
    detectAgents.mockReset().mockResolvedValue(['claude'])
    refreshAgents.mockReset().mockResolvedValue({
      agents: ['codex'],
      pathSource: 'process_env',
      pathFailureReason: 'none'
    })
  })

  it('deduplicates Floating-first callers without cached or settlement broadcast fanout', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore([])
    let broadcasts = 0
    const unsubscribe = store.subscribe(() => {
      broadcasts += 1
    })

    const floating = store.getState().ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    const ordinary = store.getState().ensureDetectedAgents()
    const joinedOrdinary = store.getState().ensureDetectedAgents()

    expect(detectAgents).toHaveBeenCalledTimes(1)
    expect(ordinary).toBe(floating)
    expect(joinedOrdinary).toBe(floating)
    broadcasts = 0
    resolveDetection(['codex'])
    await Promise.all([floating, ordinary, joinedOrdinary])
    expect(broadcasts).toBe(1)

    broadcasts = 0
    await store.getState().ensureDetectedAgents()
    await store.getState().ensureDetectedAgents()
    expect(broadcasts).toBe(0)
    unsubscribe()
  })

  it('keeps native provider inventory across WSL selection and refresh', async () => {
    const store = createTestStore([makeRepo('repo-1')])
    const projects = store.getState().projects
    detectAgents.mockResolvedValueOnce(['grok']).mockResolvedValueOnce([])
    await store.getState().ensureNativeDetectedAgents()
    expect(detectAgents).toHaveBeenNthCalledWith(1, undefined)
    await store.getState().ensureDetectedAgents()
    await store.getState().refreshDetectedAgents()
    expect(readNativeDetectedAgents(store.getState())).toEqual(['grok'])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    const inventory = store.getState().readLocalAgentInventory(FLOATING_TERMINAL_WORKTREE_ID)
    expect(inventory).toEqual({ ids: ['grok'], state: 'successful' })
    store.setState({ projects: [] })
    refreshAgents.mockRejectedValueOnce(new Error('native refresh failed'))
    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['grok'])
    expect(readNativeDetectedAgents(store.getState())).toEqual(['grok'])
    expect(store.getState().detectedAgentIds).toEqual(['grok'])
    expect(store.getState().isRefreshingAgents).toBe(false)
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})
    await expect(store.getState().ensureNativeDetectedAgents()).resolves.toEqual(['grok'])
    expect(detectAgents).toHaveBeenCalledTimes(2)

    let finish: (result: { agents: string[] }) => void = () => {}
    refreshAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    store.setState({ projects })
    const wslRefresh = store.getState().refreshDetectedAgents()
    expect(store.getState().detectedAgentIds).toBeNull()
    finish({ agents: ['codex'] })
    await wslRefresh
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(readNativeDetectedAgents(store.getState())).toEqual(['grok'])
    store.setState({ projects: [] })
    await store.getState().refreshDetectedAgents()
    expect(readNativeDetectedAgents(store.getState())).toEqual(['codex'])
  })

  it('evicts removed project contexts without retaining settled loading entries', async () => {
    const repo1 = makeRepo('repo-1')
    const repo2 = makeRepo('repo-2')
    const store = createTestStore([repo1, repo2])

    await store.getState().ensureDetectedAgents()
    store.setState({ activeRepoId: 'repo-2' })
    await store.getState().ensureDetectedAgents()

    expect(Object.keys(store.getState().localDetectedAgentIdsByContext)).toEqual([
      'repo-1:wsl:Ubuntu',
      'repo-2:wsl:Ubuntu'
    ])
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})

    store.setState({ repos: [repo2] })
    store.getState().clearLocalDetectedAgentContextsForProjects(['repo-1'])

    expect(store.getState().localDetectedAgentIdsByContext).toEqual({
      'repo-2:wsl:Ubuntu': ['claude']
    })

    store.setState({ repos: [repo1, repo2], activeRepoId: 'repo-1' })
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    expect(detectAgents).toHaveBeenCalledTimes(3)
  })

  it('does not restore a project context cleared while detection is in flight', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore([makeRepo('repo-1')])

    const pending = store.getState().ensureDetectedAgents()
    store.getState().clearLocalDetectedAgentContextsForProjects(['repo-1'])
    resolveDetection(['claude'])

    await expect(pending).resolves.toEqual(['claude'])
    expect(store.getState().localDetectedAgentIdsByContext).toEqual({})
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
    expect(store.getState().detectedAgentIds).toBeNull()
  })

  it('does not let an older detect overwrite a successful refresh', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    const store = createTestStore([])

    const detect = store.getState().ensureDetectedAgents()
    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['codex'])
    resolveDetection(['claude'])
    await expect(detect).resolves.toEqual(['claude'])

    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().localDetectedAgentIdsByContext.host).toEqual(['codex'])
    expect(store.getState().isDetectingAgents).toBe(false)
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
  })

  it('does not let an older failed detect erase a successful refresh', async () => {
    let rejectDetection: (error: Error) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((_resolve, reject) => {
        rejectDetection = reject
      })
    )
    const store = createTestStore([])

    const detect = store.getState().ensureDetectedAgents()
    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['codex'])
    rejectDetection(new Error('older detect failed'))
    await expect(detect).resolves.toEqual([])

    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().localDetectedAgentIdsByContext.host).toEqual(['codex'])
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['codex'])
    expect(detectAgents).toHaveBeenCalledTimes(1)
  })

  it('joins an authoritative refresh instead of starting a later detect', async () => {
    let resolveRefresh: (result: {
      agents: string[]
      pathSource: string
      pathFailureReason: string
    }) => void = () => {}
    refreshAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve
      })
    )
    const store = createTestStore([])

    const refresh = store.getState().refreshDetectedAgents()
    const ensure = store.getState().ensureDetectedAgents()
    expect(ensure).toBe(refresh)
    expect(detectAgents).not.toHaveBeenCalled()

    resolveRefresh({
      agents: ['codex'],
      pathSource: 'process_env',
      pathFailureReason: 'none'
    })
    await expect(Promise.all([refresh, ensure])).resolves.toEqual([['codex'], ['codex']])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().localDetectedAgentIdsByContext.host).toEqual(['codex'])
  })

  it('retries after an authoritative refresh fails without a usable cache', async () => {
    let resolveDetection: (agents: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDetection = resolve
      })
    )
    refreshAgents.mockRejectedValueOnce(new Error('transient refresh failure'))
    const store = createTestStore([])

    const supersededDetect = store.getState().ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    await expect(
      store.getState().refreshDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    ).resolves.toEqual([])
    resolveDetection(['stale'])
    await expect(supersededDetect).resolves.toEqual(['stale'])

    await expect(
      store.getState().ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    ).resolves.toEqual(['claude'])
    expect(detectAgents).toHaveBeenCalledTimes(2)
    expect(store.getState().localDetectedAgentIdsByContext.host).toEqual(['claude'])
  })
})
