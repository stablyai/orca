// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Automation,
  AutomationRun,
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import type { AutomationListRow } from './automation-list-row-identity'
import type { ExternalAutomationScope } from './external-automation-scope-client'
import { AutomationListLocalRows } from './AutomationListLocalRows'
import { AutomationListExternalRows } from './AutomationListExternalRows'
import { indexLatestAutomationRuns } from './automation-list-last-run'

// Why: Tooltip needs a provider in the app; stub so rows render standalone.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'test',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'worktree-1',
    baseBranch: null,
    reuseSession: false,
    timezone: 'America/Los_Angeles',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: Date.now() + 60_000,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeExternalJob(overrides: Partial<ExternalAutomationJob> = {}): ExternalAutomationJob {
  return {
    id: 'job-1',
    managerId: 'manager-1',
    provider: 'hermes',
    name: 'Nightly',
    schedule: '0 0 * * *',
    rawSchedule: null,
    enabled: true,
    state: 'enabled',
    prompt: null,
    promptPreview: '',
    nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    workdir: null,
    runCount: 0,
    runs: [],
    ...overrides
  }
}

function makeExternalManager(): ExternalAutomationManager {
  return {
    id: 'manager-1',
    provider: 'hermes',
    label: 'Local Hermes',
    targetLabel: 'Local',
    target: { type: 'local' },
    status: 'available',
    error: null,
    canManage: true,
    jobs: []
  }
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'test',
    scheduledFor: 1,
    status: 'dispatch_failed',
    trigger: 'scheduled',
    workspaceId: 'worktree-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: 'boom',
    startedAt: Date.now() - 8 * 60 * 60 * 1000,
    dispatchedAt: Date.now() - 8 * 60 * 60 * 1000,
    createdAt: Date.now() - 8 * 60 * 60 * 1000,
    ...overrides
  }
}

function renderLocalRows(handlers: {
  onSelect: (rowKey: string) => void
  onDelete?: (row: AutomationListRow) => void
  runs?: AutomationRun[]
}) {
  const row: AutomationListRow = {
    key: 'row|local|automation-1',
    automation: makeAutomation(),
    hostLabel: 'Local',
    usageSummary: null
  }
  return render(
    <AutomationListLocalRows
      rows={[row]}
      selectedRowKey={null}
      isSelectedLocal={true}
      lastRunByAutomationId={indexLatestAutomationRuns(handlers.runs ?? [])}
      relativeNow={Date.now()}
      repoMap={new Map()}
      worktreeMap={new Map()}
      projectHostSetups={[]}
      sshConnectionStates={new Map()}
      runtimeStatusByEnvironmentId={new Map()}
      hostTargetFor={() => null}
      automationSourceHostAvailabilityByRowKey={new Map()}
      hostLabelById={new Map()}
      onSelect={handlers.onSelect}
      onRunNow={vi.fn()}
      onEdit={vi.fn()}
      onToggle={vi.fn()}
      onDelete={handlers.onDelete ?? vi.fn()}
    />
  )
}

function renderExternalRows(handlers: {
  onSelect: (entryKey: string) => void
  onRequestAction?: (
    manager: ExternalAutomationManager,
    job: ExternalAutomationJob,
    action: 'run' | 'pause' | 'resume' | 'delete',
    scope: ExternalAutomationScope
  ) => void
}) {
  const manager = makeExternalManager()
  const job = makeExternalJob()
  const scope: ExternalAutomationScope = {
    owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
    provider: 'hermes'
  }
  return render(
    <AutomationListExternalRows
      entries={[{ key: `${manager.id}:${job.id}`, scope, manager, job }]}
      selectedExternalKey={null}
      relativeNow={Date.now()}
      sshConnectionStates={new Map()}
      externalActionKey={null}
      onSelect={handlers.onSelect}
      onRequestAction={handlers.onRequestAction ?? vi.fn()}
      onEdit={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Automation list row selection', () => {
  it('does not open local detail when a quick-action menu item is chosen', async () => {
    // Radix portals the menu out of the row's DOM, but React bubbles its
    // clicks back through the component tree. Selecting Delete must not call
    // onSelect (which opens the detail page behind the confirm dialog).
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    renderLocalRows({ onSelect, onDelete })
    const user = userEvent.setup()

    await user.click(
      screen.getByRole('button', {
        name: 'Automation actions'
      })
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows last-run status and relative time', () => {
    renderLocalRows({ onSelect: vi.fn(), runs: [makeRun()] })
    expect(screen.getByText('Failed 8h ago')).toBeTruthy()
  })

  it('still selects when the local row itself is clicked', async () => {
    const onSelect = vi.fn()
    const { container } = renderLocalRows({ onSelect })
    const user = userEvent.setup()

    const row = container.querySelector('[data-slot="context-menu-trigger"]')
    expect(row).not.toBeNull()
    await user.click(row as Element)

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('row|local|automation-1')
  })

  it('opens the actions menu on keyboard activation without selecting the row', async () => {
    // The row handles Enter/Space for its own activation. Those keys bubble
    // from the actions trigger too, so an unguarded row handler would
    // preventDefault the button's native activation and open detail instead.
    const onSelect = vi.fn()
    renderLocalRows({ onSelect })
    const user = userEvent.setup()

    screen.getByRole('button', { name: 'Automation actions' }).focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not open external detail when a quick-action menu item is chosen', async () => {
    const onSelect = vi.fn()
    const onRequestAction = vi.fn()
    renderExternalRows({ onSelect, onRequestAction })
    const user = userEvent.setup()

    await user.click(
      screen.getByRole('button', {
        name: 'Automation actions'
      })
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))

    expect(onRequestAction).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
