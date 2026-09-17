// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'

const mocks = vi.hoisted(() => ({
  expandProjectFolderOnAutomationRun: vi.fn(),
  prepareAutomationDispatchWorkspace: vi.fn(),
  resolveAutomationDispatchWorkspace: vi.fn(),
  createAutomationDispatchCompletion: vi.fn(),
  markDispatchResult: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({})
  }
}))

vi.mock('@/components/automations/automation-run-actions', () => ({
  expandProjectFolderOnAutomationRun: (...args: unknown[]) =>
    mocks.expandProjectFolderOnAutomationRun(...args)
}))

vi.mock('./automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: (...args: unknown[]) =>
    mocks.resolveAutomationDispatchWorkspace(...args),
  prepareAutomationDispatchWorkspace: (...args: unknown[]) =>
    mocks.prepareAutomationDispatchWorkspace(...args)
}))

vi.mock('./automation-dispatch-completion', () => ({
  createAutomationDispatchCompletion: (...args: unknown[]) =>
    mocks.createAutomationDispatchCompletion(...args)
}))

vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: () => null
}))

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: vi.fn()
}))

vi.stubGlobal('window', {
  api: {
    automations: {
      markDispatchResult: mocks.markDispatchResult
    }
  }
})

import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

describe('handleAutomationDispatchRequest folder expansion (#20113)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveAutomationDispatchWorkspace.mockReturnValue({
      repo: { id: 'repo-1' },
      context: { precheckResult: null }
    })
    mocks.prepareAutomationDispatchWorkspace.mockResolvedValue({
      id: 'wt-123',
      hostId: 'local'
    })
    mocks.createAutomationDispatchCompletion.mockReturnValue({
      cleanupRunObservers: vi.fn(),
      setReuseDispatchTabRelease: vi.fn(),
      settlePendingAfterDispatch: vi.fn()
    })
  })

  it('calls expandProjectFolderOnAutomationRun when scheduled run workspace is prepared', async () => {
    const automation = {
      id: 'auto-1',
      agentId: 'codex',
      prompt: 'do work',
      reuseSession: false,
      runContext: { hostId: 'local' }
    } as unknown as Automation

    const run = {
      id: 'run-1',
      runContext: { hostId: 'local' }
    } as unknown as AutomationRun

    await handleAutomationDispatchRequest({
      automation,
      run,
      dispatchToken: 'token-1'
    })

    expect(mocks.expandProjectFolderOnAutomationRun).toHaveBeenCalledWith('wt-123', 'local')
  })

  it('does not expand if workspace preparation returns null', async () => {
    mocks.prepareAutomationDispatchWorkspace.mockResolvedValue(null)

    const automation = {
      id: 'auto-1',
      agentId: 'codex',
      prompt: 'do work',
      reuseSession: false
    } as unknown as Automation

    const run = { id: 'run-1' } as unknown as AutomationRun

    await handleAutomationDispatchRequest({
      automation,
      run,
      dispatchToken: 'token-1'
    })

    expect(mocks.expandProjectFolderOnAutomationRun).not.toHaveBeenCalled()
  })
})
