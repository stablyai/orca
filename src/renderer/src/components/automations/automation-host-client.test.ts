import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import {
  createAutomationForTarget,
  getAutomationListTarget,
  listAutomationsForTarget,
  runAutomationNowForTarget
} from './automation-host-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

const mockApi = {
  automations: {
    list: vi.fn(),
    listRuns: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    runNow: vi.fn()
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Remote check',
    prompt: 'Check',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'remote_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    runContext: {
      kind: 'workspace-run',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:gpu',
      projectHostSetupId: 'setup-gpu',
      repoId: 'repo-1',
      path: '/srv/orca'
    },
    ...overrides
  }
}

describe('automation host client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists automations from the active remote server when one is selected', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automations: [makeAutomation()] })

    const target = getAutomationListTarget({ activeRuntimeEnvironmentId: 'gpu' })
    const automations = await listAutomationsForTarget(target)

    expect(automations).toHaveLength(1)
    expect(mockApi.automations.list).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.list',
      undefined,
      { timeoutMs: 15_000 }
    )
  })

  it('creates and manually runs runtime-host automations through that server', async () => {
    const automation = makeAutomation()
    const input: AutomationCreateInput = {
      name: automation.name,
      prompt: automation.prompt,
      precheck: null,
      agentId: automation.agentId,
      runContext: automation.runContext,
      projectId: automation.projectId,
      workspaceMode: automation.workspaceMode,
      workspaceId: null,
      timezone: automation.timezone,
      rrule: automation.rrule,
      dtstart: automation.dtstart
    }
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ automation })
      .mockResolvedValueOnce({ run: { id: 'run-1', automationId: automation.id } })

    await createAutomationForTarget(input)
    await runAutomationNowForTarget(automation)

    expect(mockApi.automations.create).not.toHaveBeenCalled()
    expect(mockApi.automations.runNow).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      { kind: 'environment', environmentId: 'gpu' },
      'automation.create',
      expect.objectContaining({
        repo: 'repo-1',
        workspace: undefined,
        runContext: automation.runContext
      }),
      { timeoutMs: 15_000 }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'gpu' },
      'automation.runNow',
      { id: automation.id },
      { timeoutMs: 15_000 }
    )
  })
})
