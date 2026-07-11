import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import {
  createAutomationForTarget,
  getAutomationListTarget,
  listExternalAutomationManagersForTarget,
  runExternalAutomationActionForTarget,
  listAutomationsForTarget,
  runAutomationNowForTarget,
  updateAutomationForTarget
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
    runNow: vi.fn(),
    listExternalManagers: vi.fn(),
    listExternalRuns: vi.fn(),
    createExternal: vi.fn(),
    updateExternal: vi.fn(),
    runExternalAction: vi.fn()
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
      setupDecision: 'run',
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
        setupDecision: 'run',
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

  it('updates and manually runs SSH-host automations through the remote server that listed them', async () => {
    const automation = makeAutomation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'github:stablyai/orca',
        hostId: 'ssh:devbox',
        projectHostSetupId: 'setup-devbox',
        repoId: 'repo-1',
        path: '/srv/orca'
      }
    })
    const sourceTarget = { kind: 'environment' as const, environmentId: 'gpu' }
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ automation: { ...automation, name: 'Updated' } })
      .mockResolvedValueOnce({ run: { id: 'run-1', automationId: automation.id } })

    await updateAutomationForTarget(automation, { name: 'Updated' }, sourceTarget)
    await runAutomationNowForTarget(automation, sourceTarget)

    expect(mockApi.automations.update).not.toHaveBeenCalled()
    expect(mockApi.automations.runNow).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      1,
      sourceTarget,
      'automation.update',
      { id: automation.id, updates: { name: 'Updated' } },
      { timeoutMs: 15_000 }
    )
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      sourceTarget,
      'automation.runNow',
      { id: automation.id },
      { timeoutMs: 15_000 }
    )
  })

  it('routes Hermes managers and actions through the selected Orca runtime', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({
        managers: [
          {
            id: 'hermes:local',
            provider: 'hermes',
            label: 'Hermes on this computer',
            targetLabel: 'this computer',
            target: { type: 'local' },
            status: 'available',
            error: null,
            canManage: true,
            jobs: [
              {
                id: 'job-1',
                managerId: 'hermes:local',
                provider: 'hermes',
                name: 'Digest',
                schedule: 'Hourly',
                rawSchedule: '0 * * * *',
                enabled: true,
                state: 'active',
                prompt: 'Digest',
                promptPreview: 'Digest',
                nextRunAt: null,
                lastRunAt: null,
                lastStatus: null,
                lastError: null,
                workdir: null,
                runCount: 0,
                runs: []
              }
            ]
          }
        ]
      })
      .mockResolvedValueOnce({ acted: true })

    const managers = await listExternalAutomationManagersForTarget({
      kind: 'environment',
      environmentId: 'gpu'
    })
    await runExternalAutomationActionForTarget({
      managerId: managers[0].id,
      provider: 'hermes',
      target: managers[0].target,
      jobId: 'job-1',
      action: 'run'
    })

    expect(managers[0]).toMatchObject({
      id: 'hermes:runtime:gpu',
      target: { type: 'runtime', environmentId: 'gpu' },
      jobs: [{ managerId: 'hermes:runtime:gpu' }]
    })
    expect(callRuntimeRpc).toHaveBeenNthCalledWith(
      2,
      { kind: 'environment', environmentId: 'gpu' },
      'automation.externalAction',
      {
        managerId: 'hermes:runtime:gpu',
        provider: 'hermes',
        jobId: 'job-1',
        action: 'run'
      },
      { timeoutMs: 30_000 }
    )
    expect(mockApi.automations.runExternalAction).not.toHaveBeenCalled()
  })
})
