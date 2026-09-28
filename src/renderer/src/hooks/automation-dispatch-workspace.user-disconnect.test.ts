// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Automation, AutomationRun } from '../../../shared/automations-types'
import {
  prepareAutomationDispatchWorkspace,
  resolveAutomationDispatchWorkspace
} from './automation-dispatch-workspace'

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly',
  prompt: 'run this',
  precheck: null,
  agentId: 'claude',
  projectId: 'repo-ssh',
  executionTargetType: 'ssh',
  executionTargetId: 'ssh-1',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 60,
  createdAt: 0,
  updatedAt: 0
}

const run: AutomationRun = {
  id: 'run-1',
  automationId: automation.id,
  title: 'Nightly',
  scheduledFor: 0,
  status: 'dispatching',
  trigger: 'scheduled',
  workspaceId: null,
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 0
}

describe("automation dispatch on a host the user's Disconnect holds down", () => {
  const ensureConnected = vi.fn()
  const getState = vi.fn()

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ sshTargetLabels: new Map([['ssh-1', 'devbox']]) })
    ensureConnected.mockReset().mockRejectedValue(new Error('devbox was disconnected.'))
    getState.mockReset().mockResolvedValue({
      targetId: 'ssh-1',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0,
      disconnectedBy: 'user'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: { needsPassphrasePrompt: vi.fn().mockResolvedValue(false), getState, ensureConnected }
      }
    })
  })

  it('skips the run with a plain reason and dials nothing else', async () => {
    const state = useAppStore.getState()
    const resolved = resolveAutomationDispatchWorkspace(state, automation, run)
    const markDispatchResult = vi.fn().mockResolvedValue(undefined)

    const worktree = await prepareAutomationDispatchWorkspace({
      state,
      automation,
      run,
      dispatchToken: 'token-1',
      resolved: {
        ...resolved,
        repo: {
          id: 'repo-ssh',
          path: '/srv/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      },
      markDispatchResult
    })

    expect(worktree).toBeNull()
    expect(ensureConnected).toHaveBeenCalledTimes(1)
    expect(markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'skipped_unavailable',
        error: 'Skipped: you disconnected devbox. Connect it again to resume.'
      })
    )
  })
})
