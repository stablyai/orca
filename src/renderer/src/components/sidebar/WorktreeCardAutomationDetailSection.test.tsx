// @vitest-environment happy-dom

/** Automation ownership comes from provenance and may differ from the resulting workspace’s host. */

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AutomationWorkspaceProvenance } from '../../../../shared/worktree/types'
import type * as AutomationHostClient from '@/components/automations/automation-host-client'
import { WorktreeCardAutomationDetailSection } from './WorktreeCardAutomationDetailSection'

const mocks = vi.hoisted(() => ({
  listAutomationsForTarget: vi.fn(),
  listAutomationRunsForTarget: vi.fn()
}))

vi.mock('@/components/automations/automation-host-client', async (importOriginal) => ({
  ...(await importOriginal<typeof AutomationHostClient>()),
  listAutomationsForTarget: mocks.listAutomationsForTarget,
  listAutomationRunsForTarget: mocks.listAutomationRunsForTarget
}))

function provenance(
  overrides: Partial<AutomationWorkspaceProvenance> = {}
): AutomationWorkspaceProvenance {
  return {
    kind: 'created-by-automation',
    automationId: 'a-1',
    automationNameSnapshot: 'Nightly',
    automationRunId: 'run-1',
    automationRunTitleSnapshot: 'Nightly #1',
    createdAt: 1,
    executionTargetType: 'local',
    executionTargetId: 'local',
    projectId: 'repo-1',
    ...overrides
  }
}

const roots: Root[] = []

async function render(
  record: AutomationWorkspaceProvenance,
  handlers: {
    onOpenAutomation?: (event: React.MouseEvent) => void
    onOpenAutomationRun?: (event: React.MouseEvent) => void
  } = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <WorktreeCardAutomationDetailSection provenance={record} {...handlers} />
      </TooltipProvider>
    )
  })
  return container
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  mocks.listAutomationsForTarget.mockResolvedValue([])
  mocks.listAutomationRunsForTarget.mockResolvedValue([])
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
})

describe('WorktreeCardAutomationDetailSection host resolution', () => {
  it('asks the host the provenance recorded', async () => {
    mocks.listAutomationsForTarget.mockResolvedValue([{ id: 'a-1' }])
    mocks.listAutomationRunsForTarget.mockResolvedValue([{ id: 'run-1' }])

    await render(provenance({ hostId: 'runtime:gpu' }))

    expect(mocks.listAutomationsForTarget).toHaveBeenCalledWith({
      kind: 'environment',
      environmentId: 'gpu'
    })
  })

  it('reports a miss as uncheckable when no host was ever recorded', async () => {
    const container = await render(provenance())

    // An unqualified desktop miss cannot establish that a host-owned automation was removed.
    expect(container.textContent).toContain('Automation availability could not be checked.')
    expect(container.textContent).not.toContain('Automation no longer available.')
  })

  it('still reports a miss as removed when the recorded host answered', async () => {
    const container = await render(provenance({ hostId: 'local' }))

    expect(container.textContent).toContain('Automation no longer available.')
  })

  it('offers both affordances when a record with no recorded host is found anyway', async () => {
    // A positive desktop result remains evidence even when recorded host provenance is missing.
    mocks.listAutomationsForTarget.mockResolvedValue([{ id: 'a-1' }])
    mocks.listAutomationRunsForTarget.mockResolvedValue([{ id: 'run-1' }])

    const container = await render(provenance(), {
      onOpenAutomation: vi.fn(),
      onOpenAutomationRun: vi.fn()
    })

    expect(container.querySelector('[aria-label="Open automation"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Open run"]')).not.toBeNull()
    expect(container.textContent).not.toContain('could not be checked')
  })
})
