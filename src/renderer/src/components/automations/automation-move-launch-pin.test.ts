import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationCreateInput } from '../../../../shared/automations-types'

const { mockCreateAutomationAtDestination, mockDispatchAutomationDelete } = vi.hoisted(() => ({
  mockCreateAutomationAtDestination: vi.fn(),
  mockDispatchAutomationDelete: vi.fn()
}))

vi.mock('./automation-owner-action-runner', () => ({
  createAutomationAtDestination: mockCreateAutomationAtDestination
}))

vi.mock('./automation-host-client', () => ({
  deleteAutomationForTarget: vi.fn(),
  listAutomationsForTarget: vi.fn(),
  updateAutomationForTarget: vi.fn()
}))

vi.mock('./automation-row-action-dispatch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, dispatchAutomationDelete: mockDispatchAutomationDelete }
})

import type {
  AutomationAuthorityRef,
  StableAutomationCatalogRef
} from '../../../../shared/automation-owner-ref'
import type { AutomationCreateDestination } from './automation-create-destination'
import {
  moveAutomationToDestination,
  type AutomationMoveOperationContext
} from './automation-orca-save-operations'

const source: Automation = {
  id: 'auto-1',
  name: 'Nightly triage',
  prompt: 'Triage the backlog',
  precheck: null,
  agentId: 'claude',
  model: 'opus',
  effort: 'high',
  projectId: 'repo-1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
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
  updatedAt: 1
}

// The editor draft, which has no model or effort field of its own.
const input: AutomationCreateInput = {
  name: source.name,
  prompt: source.prompt,
  precheck: null,
  agentId: source.agentId,
  projectId: source.projectId,
  workspaceMode: source.workspaceMode,
  workspaceId: source.workspaceId,
  baseBranch: source.baseBranch,
  reuseSession: false,
  timezone: source.timezone,
  rrule: source.rrule,
  dtstart: source.dtstart,
  missedRunGraceMinutes: source.missedRunGraceMinutes
}

const authority: AutomationAuthorityRef = { kind: 'desktop' }
const stableRef: StableAutomationCatalogRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}

const context: AutomationMoveOperationContext = {
  automationDispatchContext: { capturedOwners: new Map(), authority },
  editingRowKey: 'row-1',
  automationDialogTarget: { kind: 'local' },
  moveCreationKeysRef: { current: new Map<string, string>() },
  invalidateWrittenHost: vi.fn()
}

const target: AutomationCreateDestination = {
  authority,
  destination: { selector: { kind: 'self' } },
  entry: {
    stableRef,
    owner: { authority, selector: { kind: 'self' } },
    stableKey: 'host-2',
    label: 'Other host',
    authorityLabel: 'Other host',
    kind: 'self',
    catalogState: 'authoritative',
    authorityHealth: 'fresh',
    executionHealth: 'connected',
    querySupport: 'scoped'
  }
}

async function move(pinned: Partial<Automation> = {}): Promise<AutomationCreateInput> {
  await moveAutomationToDestination(context, { ...source, ...pinned }, target, input)
  return mockCreateAutomationAtDestination.mock.calls[0]?.[1]
}

describe('moving an automation across hosts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    context.moveCreationKeysRef.current.clear()
    mockCreateAutomationAtDestination.mockResolvedValue({ status: 'ok', value: source })
    mockDispatchAutomationDelete.mockResolvedValue({ ok: true, value: undefined })
  })

  it('carries the pinned model and effort onto the destination copy', async () => {
    expect(await move()).toMatchObject({ model: 'opus', effort: 'high' })
  })

  it('pins nothing on the copy of an automation that has no pin', async () => {
    const created = await move({ model: null, effort: null })

    expect(created).not.toHaveProperty('model')
    expect(created).not.toHaveProperty('effort')
  })
})
