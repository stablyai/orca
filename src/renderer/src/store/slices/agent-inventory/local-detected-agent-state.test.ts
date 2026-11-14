import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { Repo } from '../../../../../shared/repo-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../../shared/constants'
import { readNativeDetectedAgents } from './local-detected-agent-store-state'
import { createDetectedAgentsSlice } from './create-detected-agents-slice'

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

  it('sends explicit catalog intent even while an automatic refresh is pending', async () => {
    const store = createTestStore([])
    const automaticReply = Promise.withResolvers<{ agents: string[] }>()
    refreshAgents.mockImplementation((args) =>
      args?.userInitiated ? Promise.resolve({ agents: ['grok'] }) : automaticReply.promise
    )
    const automatic = store.getState().refreshDetectedAgents()
    const explicit = store.getState().refreshDetectedAgents(undefined, { userInitiated: true })
    expect(store.getState().refreshDetectedAgents(undefined, { userInitiated: true })).toBe(
      explicit
    )
    expect(await explicit).toEqual(['grok'])
    automaticReply.resolve({ agents: ['claude'] })
    await automatic
    expect(store.getState().detectedAgentIds).toEqual(['grok'])
    expect(refreshAgents).toHaveBeenCalledWith(expect.objectContaining({ userInitiated: true }))
  })

  it('keeps complete Settings inventory separate from automatic probes in either completion order', async () => {
    const store = createTestStore([])
    const resolveDetection = new Map<boolean, (ids: string[]) => void>()
    detectAgents.mockImplementation(
      (args) =>
        new Promise<string[]>((resolve) => {
          resolveDetection.set(args?.enabledOnly === true, resolve)
        })
    )
    const automatic = store.getState().ensureDetectedAgents()
    const settings = store.getState().ensureAllDetectedAgents()
    expect(store.getState().ensureAllDetectedAgents()).toBe(settings)
    resolveDetection.get(true)?.(['claude'])
    await automatic
    expect(store.getState().localDetectedAgentIdsByContext['host\u0000all-agents']).toBeNull()
    resolveDetection.get(false)?.(['claude', 'kiro'])
    await settings
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
    expect(store.getState().localDetectedAgentIdsByContext['host\u0000all-agents']).toEqual([
      'claude',
      'kiro'
    ])
    await expect(store.getState().ensureAllDetectedAgents()).resolves.toEqual(['claude', 'kiro'])

    store.getState().clearLocalDetectedAgents()
    const nextAutomatic = store.getState().ensureDetectedAgents()
    const nextSettings = store.getState().ensureAllDetectedAgents()
    resolveDetection.get(false)?.(['codex', 'kiro'])
    await nextSettings
    resolveDetection.get(true)?.(['codex'])
    await nextAutomatic
    expect(store.getState().localDetectedAgentIdsByContext['host\u0000all-agents']).toEqual([
      'codex',
      'kiro'
    ])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
  })

  it('retries a refused list as a wake when an agent picker opens, without joining a background probe', async () => {
    const store = createTestStore([makeRepo('repo-1')])
    detectAgents.mockRejectedValueOnce(new Error("WSL distro 'Ubuntu' is not running."))
    await store.getState().ensureDetectedAgents()
    expect(store.getState().readLocalAgentInventory().state).toBe('failed')

    let finishBackground: (ids: string[]) => void = () => {}
    detectAgents
      .mockReturnValueOnce(
        new Promise<string[]>((resolve) => {
          finishBackground = resolve
        })
      )
      .mockResolvedValueOnce(['codex'])
    const background = store.getState().ensureDetectedAgents()
    const picker = store.getState().ensureDetectedAgentsForPicker()

    expect(detectAgents).toHaveBeenLastCalledWith(expect.objectContaining({ wakeWslDistro: true }))
    await expect(picker).resolves.toEqual(['codex'])
    // The background probe settles later but no longer owns the context.
    finishBackground([])
    await background
    expect(store.getState().readLocalAgentInventory()).toEqual({
      ids: ['codex'],
      state: 'successful'
    })
    // A known list is reused: opening the picker again probes nothing.
    detectAgents.mockClear()
    await store.getState().ensureDetectedAgentsForPicker()
    expect(detectAgents).not.toHaveBeenCalled()
  })

  it('re-detects re-enabled agents and prevents pre-change requests from restoring caches', async () => {
    const store = createTestStore([])
    let finishOld: (ids: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        finishOld = resolve
      })
    )
    const stale = store.getState().ensureDetectedAgents()
    const settings = store.getState().settings!
    store.setState({ settings: { ...settings, disabledTuiAgents: ['kiro'] } })
    detectAgents.mockResolvedValueOnce(['claude'])
    await store.getState().ensureDetectedAgents()
    finishOld(['kiro'])
    await stale
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
    store.setState({ settings: { ...settings, disabledTuiAgents: [] } })
    expect(store.getState().detectedAgentIds).toBeNull()
    detectAgents.mockResolvedValueOnce(['claude', 'kiro'])
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude', 'kiro'])
  })

  it('successful full refresh settles both modes with detects finishing last', async () => {
    const store = createTestStore([])
    const enabledDetection = Promise.withResolvers<string[]>()
    const fullDetection = Promise.withResolvers<string[]>()
    const fullRefresh = Promise.withResolvers<{ agents: string[] }>()
    detectAgents
      .mockReturnValueOnce(enabledDetection.promise)
      .mockReturnValueOnce(fullDetection.promise)
    refreshAgents.mockReturnValueOnce(fullRefresh.promise)
    const enabled = store.getState().ensureDetectedAgents()
    const full = store.getState().ensureAllDetectedAgents()
    const refreshed = store.getState().refreshAllDetectedAgents()

    expect(store.getState().isDetectingAgents).toBe(false)
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({
      host: true,
      'host\u0000all-agents': true
    })
    const finishDetections = async () => {
      enabledDetection.resolve(['claude'])
      fullDetection.resolve(['claude', 'kiro'])
      await Promise.all([enabled, full])
    }
    fullRefresh.resolve({ agents: ['codex', 'kiro'] })
    await refreshed
    await finishDetections()

    expect(store.getState().localDetectedAgentIdsByContext).toEqual({
      host: ['codex', 'kiro'],
      'host\u0000all-agents': ['codex', 'kiro']
    })
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})
    expect(store.getState().isDetectingAgents).toBe(false)
    expect(store.getState().isRefreshingAgents).toBe(false)
  })

  it('failed full refresh settles both modes with detects finishing last', async () => {
    const store = createTestStore([])
    const enabledDetection = Promise.withResolvers<string[]>()
    const fullDetection = Promise.withResolvers<string[]>()
    const fullRefresh = Promise.withResolvers<{ agents: string[] }>()
    detectAgents
      .mockReturnValueOnce(enabledDetection.promise)
      .mockReturnValueOnce(fullDetection.promise)
    refreshAgents.mockReturnValueOnce(fullRefresh.promise)
    const enabled = store.getState().ensureDetectedAgents()
    const full = store.getState().ensureAllDetectedAgents()
    const refreshed = store.getState().refreshAllDetectedAgents()

    expect(store.getState().isDetectingAgents).toBe(false)
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({
      host: true,
      'host\u0000all-agents': true
    })
    const finishDetections = async () => {
      enabledDetection.resolve(['claude'])
      fullDetection.resolve(['claude', 'kiro'])
      await Promise.all([enabled, full])
    }
    fullRefresh.reject(new Error('shell unavailable'))
    await refreshed
    await finishDetections()

    expect(store.getState().localDetectedAgentIdsByContext).toEqual({
      host: [],
      'host\u0000all-agents': []
    })
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})
    expect(store.getState().isDetectingAgents).toBe(false)
    expect(store.getState().isRefreshingAgents).toBe(false)
  })

  it('publishes a complete refresh to automatic readers without letting their late probe overwrite it', async () => {
    const store = createTestStore([])
    store.setState({ settings: { ...store.getState().settings!, disabledTuiAgents: ['kiro'] } })
    let finishOld: (ids: string[]) => void = () => {}
    detectAgents.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        finishOld = resolve
      })
    )
    const old = store.getState().ensureDetectedAgents()
    let finishRefresh: (result: { agents: string[] }) => void = () => {}
    refreshAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve
      })
    )
    const settings = store.getState().refreshAllDetectedAgents()
    const automatic = store.getState().ensureDetectedAgents()
    expect(store.getState().refreshDetectedAgents()).toBe(automatic)
    finishOld(['claude'])
    await old
    finishRefresh({ agents: ['codex', 'kiro'] })
    await expect(settings).resolves.toEqual(['codex', 'kiro'])
    await expect(automatic).resolves.toEqual(['codex'])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().localDetectedAgentIdsByContext['host\u0000all-agents']).toEqual([
      'codex',
      'kiro'
    ])
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})
  })

  it('preserves both inventories on full refresh failure without treating a partial list as complete', async () => {
    const store = createTestStore([])
    detectAgents.mockResolvedValueOnce(['claude'])
    await store.getState().ensureDetectedAgents()
    refreshAgents.mockRejectedValueOnce(new Error('shell unavailable'))
    await expect(store.getState().refreshAllDetectedAgents()).resolves.toEqual([])
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
    expect(store.getState().localDetectedAgentIdsByContext['host\u0000all-agents']).toEqual([])
    expect(store.getState().readLocalAgentInventory().state).toBe('failed')
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})
    detectAgents.mockResolvedValueOnce(['claude', 'kiro'])
    await expect(store.getState().ensureAllDetectedAgents()).resolves.toEqual(['claude', 'kiro'])
    expect(store.getState().localDetectedAgentIdsByContext.host).toEqual(['claude'])
  })

  it('detaches both modes of a full refresh when disabled preferences change', async () => {
    const store = createTestStore([])
    let finishOld: (result: { agents: string[] }) => void = () => {}
    refreshAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve
      })
    )
    const oldSettings = store.getState().refreshAllDetectedAgents()
    const oldAutomatic = store.getState().ensureDetectedAgents()
    store.setState({ settings: { ...store.getState().settings!, disabledTuiAgents: ['kiro'] } })
    detectAgents.mockResolvedValueOnce(['codex'])
    await store.getState().ensureDetectedAgents()
    finishOld({ agents: ['claude', 'kiro'] })
    await Promise.all([oldSettings, oldAutomatic])
    expect(store.getState().detectedAgentIds).toEqual(['codex'])
    expect(store.getState().localDetectedAgentIdsByContext['host\u0000all-agents']).toBeUndefined()
    expect(store.getState().isRefreshingLocalAgentsByContext).toEqual({})
  })

  it('keeps native provider inventory across WSL selection and refresh', async () => {
    const store = createTestStore([makeRepo('repo-1')])
    const projects = store.getState().projects
    detectAgents.mockResolvedValueOnce(['grok']).mockResolvedValueOnce([])
    await store.getState().ensureNativeDetectedAgents()
    expect(detectAgents).toHaveBeenNthCalledWith(1, { enabledOnly: true })
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

  it('reacquires requested native inventory across preference changes and fences retired native probes', async () => {
    const store = createTestStore([makeRepo('repo-1')])
    const firstDetection = Promise.withResolvers<string[]>()
    const disabledDetection = Promise.withResolvers<string[]>()
    const reenabledDetection = Promise.withResolvers<string[]>()
    detectAgents
      .mockReturnValueOnce(firstDetection.promise)
      .mockReturnValueOnce(disabledDetection.promise)
      .mockReturnValueOnce(reenabledDetection.promise)
    const first = store.getState().ensureNativeDetectedAgents()
    const settings = store.getState().settings!

    store.setState({ settings: { ...settings, disabledTuiAgents: ['pi'] } })
    store.setState({ settings: { ...settings, disabledTuiAgents: [] } })
    reenabledDetection.resolve(['pi', 'codex'])
    await vi.waitFor(() =>
      expect(readNativeDetectedAgents(store.getState())).toEqual(['pi', 'codex'])
    )
    disabledDetection.resolve(['codex'])
    firstDetection.resolve(['claude'])
    await first
    expect(readNativeDetectedAgents(store.getState())).toEqual(['pi', 'codex'])
    expect(store.getState().detectedAgentIds).toBeNull()
    expect(store.getState().isDetectingLocalAgentsByContext).toEqual({})
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
    resolveDetection(['grok'])
    await expect(supersededDetect).resolves.toEqual(['grok'])

    await expect(
      store.getState().ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    ).resolves.toEqual(['claude'])
    expect(store.getState().localDetectedAgentIdsByContext.host).toEqual(['claude'])
  })
})
