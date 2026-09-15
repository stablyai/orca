import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GlobalWindowsRuntimeDefault } from '../../../../shared/project-execution-runtime'
import { createDetectedAgentsSlice } from './detected-agents'

const detectAgents = vi.fn()
const refreshAgents = vi.fn()

globalThis.window = {
  api: {
    preflight: { detectAgents, refreshAgents },
    platform: { get: () => ({ platform: 'win32' }) }
  } as unknown as Window['api']
} as Window & typeof globalThis

const sshRepo = {
  id: 'repo-ssh',
  path: '/home/alice/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0,
  connectionId: 'builder',
  executionHostId: 'ssh:builder'
} satisfies Repo

const sshWorktree = {
  id: 'repo-ssh::main',
  repoId: 'repo-ssh',
  path: '/home/alice/repo',
  hostId: 'ssh:builder'
} as unknown as Worktree

function createTestStore(
  localWindowsRuntimeDefault: GlobalWindowsRuntimeDefault = { kind: 'wsl', distro: 'Ubuntu' }
) {
  const store = create<AppState>()(
    (...args) => createDetectedAgentsSlice(...args) as unknown as AppState
  )
  store.setState({
    settings: { localWindowsRuntimeDefault },
    repos: [sshRepo],
    projects: [],
    worktreesByRepo: { 'repo-ssh': [sshWorktree] },
    activeRepoId: 'repo-ssh',
    activeWorktreeId: 'repo-ssh::main'
  } as unknown as Partial<AppState>)
  return store
}

describe('local detected agents inside an SSH workspace', () => {
  beforeEach(() => {
    // Why: mirrors the reported machine -- CLIs live in WSL, the Windows host has none.
    const agentsFor = (context: { projectRuntime?: { runtime?: { kind?: string } } }) =>
      context?.projectRuntime?.runtime?.kind === 'wsl' ? ['claude', 'codex'] : []
    detectAgents.mockReset().mockImplementation(async (context) => agentsFor(context))
    refreshAgents.mockReset().mockImplementation(async (context) => ({
      agents: agentsFor(context),
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    }))
  })

  it('refreshes in the global WSL runtime instead of the raw Windows host', async () => {
    const store = createTestStore()

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude', 'codex'])
    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['claude', 'codex'])

    const detectContext = detectAgents.mock.calls[0]?.[0]
    expect(detectContext).toMatchObject({
      projectRuntime: { runtime: { kind: 'wsl', distro: 'Ubuntu', reason: 'global-default' } }
    })
    // Why: Refresh must re-detect in the runtime the visible list came from (#18837).
    expect(refreshAgents).toHaveBeenCalledWith(detectContext)
    expect(store.getState().detectedAgentIds).toEqual(['claude', 'codex'])
  })

  it('keeps host detection when the global WSL default still needs a distro', async () => {
    // Why: mirrors main's getPreflightWslTarget, which rejects repair-required contexts.
    const hostAgentsFor = (context?: { projectRuntime?: { status?: string } }) => {
      if (context?.projectRuntime?.status === 'repair-required') {
        throw new Error('Project runtime requires repair before preflight: wsl-distro-required')
      }
      return context?.projectRuntime ? [] : ['claude']
    }
    detectAgents.mockImplementation(async (context) => hostAgentsFor(context))
    refreshAgents.mockImplementation(async (context) => ({
      agents: hostAgentsFor(context),
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'shell_hydrate',
      pathFailureReason: 'none'
    }))
    const store = createTestStore({ kind: 'wsl', distro: null })

    await expect(store.getState().ensureDetectedAgents()).resolves.toEqual(['claude'])
    await expect(store.getState().refreshDetectedAgents()).resolves.toEqual(['claude'])

    const detectContext = detectAgents.mock.calls[0]?.[0]
    expect(detectContext).toBeUndefined()
    expect(refreshAgents).toHaveBeenCalledWith(detectContext)
    expect(store.getState().detectedAgentIds).toEqual(['claude'])
  })
})
