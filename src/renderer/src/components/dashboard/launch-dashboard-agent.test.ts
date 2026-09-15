import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  getKnownWorktreeById: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  getExecutionHostIdForWorktree: vi.fn(),
  registerWorkspaceSurfaceProducer: vi.fn(),
  surfaceProducer: {
    attempt: {
      id: 'dashboard-attempt',
      workspaceKey: 'folder:docs',
      executionHostId: 'ssh:docs',
      result: Promise.resolve({
        kind: 'materialized' as const,
        surface: { kind: 'tab' as const, id: 'tab-1' }
      })
    },
    materialized: vi.fn(),
    declined: vi.fn(),
    failed: vi.fn(),
    unverifiable: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: null,
      getKnownWorktreeById: mocks.getKnownWorktreeById
    })
  }
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: mocks.getExecutionHostIdForWorktree
}))
vi.mock('@/lib/workspace-surface-production', () => ({
  registerWorkspaceSurfaceProducer: mocks.registerWorkspaceSurfaceProducer
}))

import { launchDashboardAgent } from './launch-dashboard-agent'

describe('launchDashboardAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getExecutionHostIdForWorktree.mockReturnValue('ssh:docs')
    mocks.getKnownWorktreeById.mockReturnValue({ id: 'folder:docs' })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
    mocks.launchAgentInNewTab.mockReturnValue({ tabId: 'tab-1' })
    mocks.registerWorkspaceSurfaceProducer.mockReturnValue(mocks.surfaceProducer)
  })

  it('activates a folder or git workspace on its execution host before launching', () => {
    expect(launchDashboardAgent({ worktreeId: 'folder:docs', agent: 'codex' })).toBe(true)
    expect(mocks.getKnownWorktreeById).toHaveBeenCalledWith('folder:docs', 'ssh:docs')
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('folder:docs', {
      executionHostId: 'ssh:docs'
    })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'folder:docs',
      launchSource: 'unknown'
    })
    expect(mocks.surfaceProducer.materialized).toHaveBeenCalledWith({
      kind: 'tab',
      id: 'tab-1'
    })
  })
})
