import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'
import {
  listAutomationRunsForTarget,
  listAutomationsForTarget,
  runAutomationNowForTarget,
  toRuntimeAutomationCreateInput,
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

  it('lists automations from the host it was handed, which the caller must state', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ automations: [makeAutomation()] })

    const automations = await listAutomationsForTarget({
      kind: 'environment',
      environmentId: 'gpu'
    })

    expect(automations).toHaveLength(1)
    expect(mockApi.automations.list).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.list',
      undefined,
      { timeoutMs: 15_000 }
    )
  })

  // The broad form is gone in both directions: usage totals come from the
  // authority's list projection, so nothing may ask a host for all of its runs.
  it('fetches one automation history at a time, on both the desktop and a runtime', async () => {
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({ runs: [] })

    await listAutomationRunsForTarget({ kind: 'environment', environmentId: 'gpu' }, 'auto-1')
    await listAutomationRunsForTarget({ kind: 'local' }, 'auto-1')

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.runs',
      { automationId: 'auto-1' },
      { timeoutMs: 15_000 }
    )
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'automation.runs',
      { automationId: 'auto-1' },
      { timeoutMs: 15_000 }
    )
  })

  it('manually runs runtime-host automations through that server', async () => {
    const automation = makeAutomation()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
      run: { id: 'run-1', automationId: automation.id }
    })

    await runAutomationNowForTarget(automation)

    expect(mockApi.automations.runNow).not.toHaveBeenCalled()
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.runNow',
      { id: automation.id },
      { timeoutMs: 15_000 }
    )
  })

  it('encodes exact machine selectors for the create wire input', () => {
    const automation = makeAutomation({
      workspaceMode: 'existing',
      workspaceId: 'repo-1::/srv/orca'
    })
    const input: AutomationCreateInput = {
      name: automation.name,
      prompt: automation.prompt,
      precheck: null,
      agentId: automation.agentId,
      runContext: automation.runContext,
      projectId: automation.projectId,
      workspaceMode: 'existing',
      workspaceId: automation.workspaceId,
      setupDecision: 'skip',
      timezone: automation.timezone,
      rrule: automation.rrule,
      dtstart: automation.dtstart
    }

    expect(toRuntimeAutomationCreateInput(input)).toMatchObject({
      repo: 'id:repo-1',
      workspace: 'id:repo-1::/srv/orca'
    })
    // A per-run workspace states no workspace selector at all.
    expect(
      toRuntimeAutomationCreateInput({ ...input, workspaceMode: 'new_per_run', workspaceId: null })
    ).toMatchObject({ repo: 'id:repo-1', workspace: undefined })
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
})
