import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import './local-detected-agent-store-state'
import { createDetectedAgentsSlice } from './create-detected-agents-slice'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()

globalThis.window = {
  api: {
    preflight: { detectAgents, refreshAgents },
    platform: { get: () => ({ platform: 'win32' }) }
  } as unknown as Window['api']
} as Window & typeof globalThis

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

  it('updates enabled-only inventories in place when an agent is toggled', async () => {
    const store = createTestStore([])
    detectAgents.mockResolvedValueOnce(['claude', 'kiro'])
    await store.getState().ensureAllDetectedAgents()
    refreshAgents.mockResolvedValueOnce({
      agents: ['claude', 'codex', 'kiro'],
      pathSource: 'process_env',
      pathFailureReason: 'none'
    })
    await store.getState().refreshDetectedAgents()
    detectAgents.mockClear()
    refreshAgents.mockClear()
    const settings = store.getState().settings!

    store.setState({ settings: { ...settings, disabledTuiAgents: ['codex'] } })
    expect(store.getState().detectedAgentIds).toEqual(['claude', 'kiro'])

    store.setState({ settings: { ...settings, disabledTuiAgents: [] } })
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual([
      'claude',
      'kiro',
      'codex'
    ])
    expect(detectAgents).not.toHaveBeenCalled()
    expect(refreshAgents).not.toHaveBeenCalled()
  })

  it('keeps a refresh running through a disable and publishes its filtered result', async () => {
    const store = createTestStore([])
    detectAgents.mockResolvedValueOnce(['claude', 'kiro'])
    await store.getState().ensureDetectedAgents()
    let finish: (agents: string[]) => void = () => {}
    refreshAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = (agents) =>
          resolve({ agents, pathSource: 'process_env', pathFailureReason: 'none' })
      })
    )
    const refresh = store.getState().refreshDetectedAgents()
    const settings = store.getState().settings!

    store.setState({ settings: { ...settings, disabledTuiAgents: ['kiro'] } })
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
    finish(['claude', 'codex', 'kiro'])
    await refresh
    expect(store.getState().detectedAgentIds).toEqual(['claude', 'codex'])
  })

  it('re-probes a failed inventory after an agent is toggled', async () => {
    const store = createTestStore([])
    detectAgents.mockRejectedValueOnce(new Error('probe failed'))
    await store.getState().ensureDetectedAgents()
    expect(store.getState().detectedAgentIds).toEqual([])
    const settings = store.getState().settings!

    store.setState({ settings: { ...settings, disabledTuiAgents: ['kiro'] } })
    expect(store.getState().detectedAgentIds).toBeNull()
    detectAgents.mockResolvedValueOnce(['claude'])
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
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
    finishOld(['claude', 'kiro'])
    await stale
    expect(store.getState().detectedAgentIds).toEqual(['claude'])

    let finishSkipped: (agents: string[]) => void = () => {}
    refreshAgents.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSkipped = (agents) =>
          resolve({ agents, pathSource: 'process_env', pathFailureReason: 'none' })
      })
    )
    const skipped = store.getState().refreshDetectedAgents()
    store.setState({ settings: { ...settings, disabledTuiAgents: [] } })
    expect(store.getState().detectedAgentIds).toBeNull()
    finishSkipped(['claude'])
    await skipped
    detectAgents.mockResolvedValueOnce(['claude', 'kiro'])
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude', 'kiro'])
  })
})
