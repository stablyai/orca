// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const initialHostId = (): string | null => 'local'
  return {
    store: {
      createTab: vi.fn(() => ({ id: 'new-tab' })),
      setTabCustomTitle: vi.fn(),
      setActiveTabType: vi.fn(),
      createEmptySplitGroup: vi.fn(),
      closeEmptyGroup: vi.fn()
    },
    hostId: initialHostId(),
    runtimeActive: false,
    createWebRuntimeSessionTerminalResult: vi.fn(),
    setWebRuntimeTabProps: vi.fn()
  }
})

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => mocks.store }
}))
vi.mock('@/lib/agent-session/launch/pane/launch-agent-tab-order', () => ({
  persistAgentLaunchTabOrder: vi.fn()
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({}))
vi.mock('@/lib/workspace/ownership/worktree-runtime-owner', () => ({
  getKnownExecutionHostIdForWorktree: () => mocks.hostId,
  runtimeEnvironmentIdOrLocalUnlessTwin: () => (mocks.runtimeActive ? 'env-1' : null)
}))
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => mocks.runtimeActive
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: mocks.createWebRuntimeSessionTerminalResult
}))
vi.mock('@/runtime/hosted-terminals/actions/web-runtime-tab-properties', () => ({
  setWebRuntimeTabProps: mocks.setWebRuntimeTabProps
}))

import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'
import {
  resetTerminalSessionNamesForTest,
  saveTerminalSessionName
} from '@/lib/agent-session/history/session-names/terminal-session-names'

const resume = {
  agent: 'claude' as const,
  worktreeId: 'wt-1',
  command: 'claude --resume s1',
  providerSession: { key: 'session_id' as const, id: 's1' }
}

describe('resume names the new tab after the session', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTerminalSessionNamesForTest()
    vi.clearAllMocks()
    mocks.hostId = 'local'
    mocks.runtimeActive = false
    saveTerminalSessionName({
      executionHostId: 'local',
      sessionId: 's1',
      agent: 'claude',
      tabId: 'closed-tab',
      title: 'Fix auth bug'
    })
  })

  it('names a local tab when it is created', () => {
    launchAiVaultSessionInNewTab(resume)
    expect(mocks.store.setTabCustomTitle).toHaveBeenCalledWith('new-tab', 'Fix auth bug', {
      recordInteraction: false
    })
  })

  it('leaves forks, unnamed sessions and sessions on unknown hosts without a title', () => {
    launchAiVaultSessionInNewTab({ ...resume, providerSession: undefined })
    launchAiVaultSessionInNewTab({
      ...resume,
      providerSession: { key: 'session_id', id: 's2' }
    })

    mocks.hostId = null
    launchAiVaultSessionInNewTab(resume)
    expect(mocks.store.setTabCustomTitle).not.toHaveBeenCalled()
  })

  it('names a paired host tab by the id this client will mirror it under', async () => {
    mocks.runtimeActive = true
    mocks.createWebRuntimeSessionTerminalResult.mockResolvedValue({
      outcome: { status: 'created' },
      hostTabId: 'T::L'
    })
    const launch = launchAiVaultSessionInNewTab(resume)
    expect(launch.tabId).toBeNull()
    if (launch.tabId === null) {
      await launch.runtimeLaunch
    }
    expect(mocks.setWebRuntimeTabProps).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'web-terminal-T',
      customTitle: 'Fix auth bug'
    })
  })
})
