import { describe, expect, it, vi, beforeEach } from 'vitest'
import type {
  Automation,
  AutomationCreateInput
} from '../../../../shared/automations/automation-definition'
import {
  getAutomationListedTargetFromHostId,
  toRuntimeAutomationCreateInput
} from './automation-host-client'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
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
})

describe('getAutomationListedTargetFromHostId', () => {
  const state = { runtimeEnvironments: [{ id: 'env-1' }] }

  // #32415: a web run link names 'local', but the catalog lists the server only as its runtime.
  it('lists a paired web client local and SSH hosts under its server', () => {
    Object.assign(globalThis, { __ORCA_WEB_CLIENT__: true })
    try {
      for (const hostId of ['local', 'ssh:box', undefined]) {
        expect(getAutomationListedTargetFromHostId(hostId, state)).toEqual({
          kind: 'environment',
          environmentId: 'env-1'
        })
      }
    } finally {
      Reflect.deleteProperty(globalThis, '__ORCA_WEB_CLIENT__')
    }
  })
})
