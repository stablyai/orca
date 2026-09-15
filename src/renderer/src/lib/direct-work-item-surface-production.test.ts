import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { WorkspaceSurfaceProducer } from './workspace-surface-production'

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  queueSetup: vi.fn(() => true)
}))

vi.mock('./workspace-surface-production', () => ({
  registerWorkspaceSurfaceProducer: mocks.register
}))
vi.mock('./worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local'
}))
vi.mock('./worktree-setup-issue-command-queue', () => ({
  queueStandaloneSetupTab: mocks.queueSetup
}))

import {
  beginDirectWorkItemSurfaceProduction,
  settleDirectWorkItemSurfaceProduction
} from './direct-work-item-surface-production'

const producer: WorkspaceSurfaceProducer = {
  attempt: {
    id: 'attempt-1',
    workspaceKey: 'worktree-1',
    executionHostId: 'local',
    result: Promise.resolve({ kind: 'failed', reason: 'not used' })
  },
  materialized: vi.fn(),
  declined: vi.fn(),
  failed: vi.fn(),
  unverifiable: vi.fn(),
  blocked: vi.fn(),
  unexpected: vi.fn(),
  intentionalEmpty: vi.fn()
}

describe('direct work item surface production', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.register.mockReturnValue(producer)
  })

  it('registers concrete ownership before queueing setup-only content', () => {
    const result = beginDirectWorkItemSurfaceProduction({
      store: useAppStore.getState(),
      structuredLaunch: true,
      worktreeId: 'worktree-1',
      setup: { runnerScriptPath: '/tmp/setup.sh', envVars: {} },
      issueCommand: undefined,
      defaultTabs: undefined
    })

    expect(mocks.register).toHaveBeenCalledWith({
      workspaceKey: 'worktree-1',
      executionHostId: 'local'
    })
    expect(result).toEqual({ producer, setupRunsWithoutPrimary: true })
  })

  it('does not mint ownership from an unstructured selection', () => {
    const result = beginDirectWorkItemSurfaceProduction({
      store: useAppStore.getState(),
      structuredLaunch: false,
      worktreeId: 'worktree-1',
      setup: undefined,
      issueCommand: undefined,
      defaultTabs: undefined
    })

    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.queueSetup).not.toHaveBeenCalled()
    expect(result).toEqual({ producer: null, setupRunsWithoutPrimary: false })
  })

  it('settles a structured launch with its exact session tab identity', () => {
    settleDirectWorkItemSurfaceProduction(producer, {
      completed: true,
      structuredLaunch: true,
      visibilityUnknown: false,
      failed: false,
      primaryTabId: null,
      structuredSessionId: 'session-12'
    })

    expect(producer.materialized).toHaveBeenCalledWith({
      kind: 'tab',
      id: 'agent-session:session-12'
    })
  })

  it('retains producer ownership when the host result is unknown', () => {
    settleDirectWorkItemSurfaceProduction(producer, {
      completed: false,
      structuredLaunch: true,
      visibilityUnknown: true,
      failed: false,
      primaryTabId: null
    })

    expect(producer.unverifiable).toHaveBeenCalledWith(
      'The execution host may have accepted the agent launch.'
    )
  })
})
