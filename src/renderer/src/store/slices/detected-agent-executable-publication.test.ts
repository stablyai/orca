import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/types'
import {
  _resetDetectedTuiAgentExecutables,
  getDetectedTuiAgentExecutable,
  setDetectedTuiAgentExecutables,
  type DetectedAgentExecutables
} from '../../../../shared/detected-agent-executables'
import { createDetectedAgentsSlice } from './detected-agents'

const detectAgents = vi.fn()
const detectAgentExecutables = vi.fn()
const refreshAgents = vi.fn()
const detectRemoteAgents = vi.fn()

globalThis.window = {
  api: {
    preflight: {
      detectAgents,
      detectAgentExecutables,
      refreshAgents,
      detectRemoteAgents
    },
    platform: {
      get: () => ({ platform: 'win32' })
    }
  } as unknown as Window['api']
} as Window & typeof globalThis

function makeRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0
  }
}

function createTestStore(repos: Repo[], activeRepoId: string) {
  const store = create<AppState>()(
    (...args) => createDetectedAgentsSlice(...args) as unknown as AppState
  )
  store.setState({
    repos,
    worktreesByRepo: {},
    activeRepoId,
    activeWorktreeId: null
  } as Partial<AppState>)
  return store
}

describe('detected agent executable publication', () => {
  beforeEach(() => {
    _resetDetectedTuiAgentExecutables()
    detectAgents.mockReset().mockResolvedValue(['cursor'])
    detectAgentExecutables.mockReset().mockResolvedValue({})
    refreshAgents.mockReset()
    detectRemoteAgents.mockReset()
  })

  it('publishes executable aliases before local detection resolves', async () => {
    let resolveExecutables: (executables: DetectedAgentExecutables) => void = () => {}
    detectAgentExecutables.mockReturnValueOnce(
      new Promise<DetectedAgentExecutables>((resolve) => {
        resolveExecutables = resolve
      })
    )
    const store = createTestStore(
      [makeRepo('repo-await-publication', 'C:\\repo-await-publication')],
      'repo-await-publication'
    )

    const pending = store.getState().ensureDetectedAgents()
    await vi.waitFor(() => expect(detectAgentExecutables).toHaveBeenCalledTimes(1))

    expect(store.getState().detectedAgentIds).toBeNull()
    resolveExecutables({ cursor: 'cursor' })

    await expect(pending).resolves.toEqual(['cursor'])
    expect(getDetectedTuiAgentExecutable('cursor')).toBe('cursor')
    expect(store.getState().detectedAgentIds).toEqual(['cursor'])
  })

  it('publishes refreshed aliases before refresh resolves', async () => {
    let resolveExecutables: (executables: DetectedAgentExecutables) => void = () => {}
    detectAgentExecutables.mockReturnValueOnce(
      new Promise<DetectedAgentExecutables>((resolve) => {
        resolveExecutables = resolve
      })
    )
    refreshAgents.mockResolvedValueOnce({
      agents: ['cursor'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    })
    const store = createTestStore(
      [makeRepo('repo-await-refresh', 'C:\\repo-await-refresh')],
      'repo-await-refresh'
    )

    const pending = store.getState().refreshDetectedAgents()
    await vi.waitFor(() => expect(detectAgentExecutables).toHaveBeenCalledTimes(1))

    expect(store.getState().isRefreshingAgents).toBe(true)
    resolveExecutables({ cursor: 'cursor' })

    await expect(pending).resolves.toEqual(['cursor'])
    expect(getDetectedTuiAgentExecutable('cursor')).toBe('cursor')
    expect(store.getState().isRefreshingAgents).toBe(false)
  })

  it('preserves the host snapshot after WSL detection', async () => {
    setDetectedTuiAgentExecutables({ cursor: 'cursor' }, 'win32')
    detectAgentExecutables.mockResolvedValueOnce(null)
    const store = createTestStore(
      [makeRepo('repo-wsl-preserve', '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo')],
      'repo-wsl-preserve'
    )

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['cursor'])

    expect(getDetectedTuiAgentExecutable('cursor', { platform: 'win32' })).toBe('cursor')
  })

  it('ignores a stale executable result after the detection context changes', async () => {
    let resolveStaleExecutables: (executables: DetectedAgentExecutables) => void = () => {}
    detectAgentExecutables
      .mockReturnValueOnce(
        new Promise<DetectedAgentExecutables>((resolve) => {
          resolveStaleExecutables = resolve
        })
      )
      .mockResolvedValueOnce({ cursor: 'cursor-agent' })
    const repos = [
      makeRepo('repo-stale-a', 'C:\\repo-stale-a'),
      makeRepo('repo-stale-b', 'C:\\repo-stale-b')
    ]
    const store = createTestStore(repos, 'repo-stale-a')

    const staleDetection = store.getState().ensureDetectedAgents()
    await vi.waitFor(() => expect(detectAgentExecutables).toHaveBeenCalledTimes(1))

    store.setState({ activeRepoId: 'repo-stale-b' })
    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['cursor'])
    expect(getDetectedTuiAgentExecutable('cursor')).toBe('cursor-agent')

    resolveStaleExecutables({ cursor: 'cursor' })
    await expect(staleDetection).resolves.toEqual(['cursor'])

    expect(getDetectedTuiAgentExecutable('cursor')).toBe('cursor-agent')
    expect(store.getState().detectedAgentIds).toEqual(['cursor'])
  })
})
