/* eslint-disable react-hooks/rules-of-hooks -- Why: hook wiring tests mock useEffect and invoke the hook directly. */
import type * as ReactModule from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { AutomationDispatchRequest } from '../../../shared/automations-types'

const mockLaunchAgentBackgroundSession = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockSubmitPromptToAgentTab = vi.fn()
const mockCloseWebRuntimeTerminal = vi.fn()
const mockMarkDispatchResult = vi.fn()
const mockRendererReady = vi.fn()
const mockNeedsPassphrasePrompt = vi.fn()
const mockPtyKill = vi.fn()
const mockCloseTab = vi.fn()
const mockSubscribe = vi.fn()
const mockDispatchEvent = vi.fn()

let dispatchListener: ((request: AutomationDispatchRequest) => Promise<void>) | null = null
let activeTabId = 'user-tab'

const storeState = {
  activeView: 'terminal',
  activeWorktreeId: 'wt-user',
  activeTabId,
  activeTabType: 'terminal',
  repos: [{ id: 'repo-1', connectionId: null }],
  settings: {},
  agentStatusByPaneKey: {},
  allWorktrees: vi.fn(() => [
    { id: 'wt-1', repoId: 'repo-1', path: '/repo/worktree', displayName: 'Main' }
  ]),
  closeTab: mockCloseTab,
  setActiveView: vi.fn(),
  setActiveWorktree: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn(),
  createWorktree: vi.fn()
}

function makeDispatchRequest(): AutomationDispatchRequest {
  return {
    automation: {
      id: 'automation-1',
      name: 'Nightly audit',
      prompt: 'run the audit',
      agentId: 'claude',
      projectId: 'repo-1',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'existing',
      workspaceId: 'wt-1',
      baseBranch: null,
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1,
      enabled: true,
      nextRunAt: 2,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 5,
      precheck: null,
      createdAt: 1,
      updatedAt: 1
    },
    run: {
      id: 'run-1',
      automationId: 'automation-1',
      title: 'Nightly audit',
      scheduledFor: 3,
      status: 'dispatching',
      trigger: 'manual',
      workspaceId: 'wt-1',
      workspaceDisplayName: 'Main',
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: null,
      outputSnapshot: null,
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: null,
      dispatchedAt: null,
      createdAt: 3
    }
  }
}

async function useImportedAutomationDispatchEvents(): Promise<void> {
  vi.doMock('react', async () => {
    const actual = await vi.importActual<typeof ReactModule>('react')
    return {
      ...actual,
      useEffect: (effect: () => void | (() => void)) => {
        effect()
      }
    }
  })
  vi.doMock('@/store', () => ({
    useAppStore: {
      getState: () => ({ ...storeState, activeTabId }),
      subscribe: mockSubscribe
    }
  }))
  vi.doMock('@/lib/launch-agent-background-session', () => ({
    launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
  }))
  vi.doMock('@/lib/automation-session-reuse', () => ({
    findReusableAutomationSession: mockFindReusableAutomationSession
  }))
  vi.doMock('@/lib/automation-session-observer', () => ({
    observeExistingAutomationSession: mockObserveExistingAutomationSession
  }))
  vi.doMock('@/lib/agent-paste-draft', () => ({
    submitPromptToAgentTab: mockSubmitPromptToAgentTab
  }))
  vi.doMock('@/runtime/web-runtime-session', () => ({
    closeWebRuntimeTerminal: mockCloseWebRuntimeTerminal
  }))
  vi.doMock('@/components/automations/automation-run-output-snapshot', () => ({
    createAutomationRunOutputSnapshotBuffer: () => ({
      append: vi.fn(),
      snapshot: () => 'terminal output'
    }),
    selectAutomationRunOutputSnapshot: () => ({
      format: 'plain_text',
      content: 'terminal output',
      capturedAt: 123,
      truncated: false
    })
  }))

  const { useAutomationDispatchEvents } = await import('./useAutomationDispatchEvents')
  useAutomationDispatchEvents()
}

async function dispatchAutomation(): Promise<void> {
  expect(dispatchListener).not.toBeNull()
  await dispatchListener?.(makeDispatchRequest())
}

describe('useAutomationDispatchEvents', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    dispatchListener = null
    activeTabId = 'user-tab'
    mockFindReusableAutomationSession.mockReturnValue(null)
    mockObserveExistingAutomationSession.mockResolvedValue(vi.fn())
    mockSubmitPromptToAgentTab.mockResolvedValue(true)
    mockCloseWebRuntimeTerminal.mockReturnValue(false)
    mockMarkDispatchResult.mockResolvedValue(undefined)
    mockNeedsPassphrasePrompt.mockResolvedValue(false)
    mockPtyKill.mockResolvedValue(undefined)
    mockSubscribe.mockReturnValue(vi.fn())
    mockLaunchAgentBackgroundSession.mockImplementation(async (args) => {
      args.onAgentStatus?.({
        state: 'done',
        lastAssistantMessage: 'finished'
      } as ParsedAgentStatusPayload)
      return { tabId: 'auto-tab', ptyId: 'pty-auto', startupPlan: {} }
    })
    vi.stubGlobal('window', {
      api: {
        automations: {
          onDispatchRequested: vi.fn((listener) => {
            dispatchListener = listener
            return vi.fn()
          }),
          rendererReady: mockRendererReady,
          markDispatchResult: mockMarkDispatchResult,
          listRuns: vi.fn().mockResolvedValue([])
        },
        ssh: {
          needsPassphrasePrompt: mockNeedsPassphrasePrompt,
          getState: vi.fn(),
          connect: vi.fn()
        },
        pty: {
          kill: mockPtyKill
        }
      },
      dispatchEvent: mockDispatchEvent
    })
  })

  it('reaps the hidden automation tab and local PTY after completion', async () => {
    await useImportedAutomationDispatchEvents()
    await dispatchAutomation()

    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatched', terminalSessionId: 'auto-tab' })
    )
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    )
    expect(mockCloseWebRuntimeTerminal).toHaveBeenCalledWith('pty-auto')
    expect(mockPtyKill).toHaveBeenCalledWith('pty-auto')
    expect(mockCloseTab).toHaveBeenCalledWith('auto-tab', { recordInteraction: false })
  })

  it('uses the remote-runtime terminal close path without local pty kill', async () => {
    mockCloseWebRuntimeTerminal.mockReturnValue(true)

    await useImportedAutomationDispatchEvents()
    await dispatchAutomation()

    expect(mockCloseWebRuntimeTerminal).toHaveBeenCalledWith('pty-auto')
    expect(mockPtyKill).not.toHaveBeenCalled()
    expect(mockCloseTab).toHaveBeenCalledWith('auto-tab', { recordInteraction: false })
  })

  it('leaves an actively viewed automation tab for the user to close', async () => {
    activeTabId = 'auto-tab'

    await useImportedAutomationDispatchEvents()
    await dispatchAutomation()

    expect(mockCloseWebRuntimeTerminal).not.toHaveBeenCalled()
    expect(mockPtyKill).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
  })
})
