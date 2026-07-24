// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ExternalAutomationAction,
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationProvider
} from '../../../../shared/automations-types'
import { ExternalAutomationManagers } from './ExternalAutomationManagers'

// Why: act(...) warnings are silenced by opting this module into the React act
// environment, matching how the renderer mounts under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: the run table fetches from the external automation store; stub it so the
// test stays focused on the row controls (switch + action cluster).
vi.mock('./ExternalAutomationRunTable', () => ({
  ExternalAutomationRunTable: () => <div data-testid="run-table" />
}))

// Why: Tooltip needs a TooltipProvider mounted higher in the real app; stub the
// primitives so the row renders standalone and the span trigger stays inspectable.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

function makeJob(overrides: Partial<ExternalAutomationJob> = {}): ExternalAutomationJob {
  return {
    id: 'job-1',
    managerId: 'manager-1',
    provider: 'hermes',
    name: 'Nightly backup',
    schedule: '0 0 * * *',
    rawSchedule: null,
    enabled: true,
    state: 'enabled',
    prompt: null,
    promptPreview: '',
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    workdir: null,
    runCount: 0,
    runs: [],
    ...overrides
  }
}

function makeManager(
  overrides: Partial<ExternalAutomationManager> = {}
): ExternalAutomationManager {
  const provider: ExternalAutomationProvider = overrides.provider ?? 'hermes'
  return {
    id: 'manager-1',
    provider,
    label: 'Local Hermes',
    targetLabel: 'Local',
    target: { type: 'local' },
    status: 'available',
    error: null,
    canManage: true,
    jobs: [makeJob({ provider })],
    ...overrides
  }
}

type OnActionMock = ReturnType<
  typeof vi.fn<
    (
      manager: ExternalAutomationManager,
      job: ExternalAutomationJob,
      action: ExternalAutomationAction
    ) => void
  >
>
type OnEditMock = ReturnType<
  typeof vi.fn<(manager: ExternalAutomationManager, job: ExternalAutomationJob) => void>
>

type RenderOptions = {
  runningActionKey?: string | null
  onAction?: OnActionMock
  onEdit?: OnEditMock
}

function renderManagers(
  managers: ExternalAutomationManager[],
  options: RenderOptions = {}
): { onAction: OnActionMock; onEdit: OnEditMock } {
  const onAction = options.onAction ?? vi.fn()
  const onEdit = options.onEdit ?? vi.fn()
  act(() => {
    root.render(
      <ExternalAutomationManagers
        managers={managers}
        now={0}
        runningActionKey={options.runningActionKey ?? null}
        onAction={onAction}
        onEdit={onEdit}
      />
    )
  })
  return { onAction, onEdit }
}

function getSwitch(): HTMLButtonElement {
  const node = container.querySelector('button[role="switch"]')
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error('expected a role="switch" control')
  }
  return node
}

function actionButtonLabels(): string[] {
  return Array.from(container.querySelectorAll('button[aria-label]')).map(
    (button) => button.getAttribute('aria-label') ?? ''
  )
}

describe('ExternalAutomationManagers toggle', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('renders a switch reflecting the enabled state via aria-checked', () => {
    renderManagers([makeManager({ jobs: [makeJob({ enabled: true })] })])
    expect(getSwitch().getAttribute('aria-checked')).toBe('true')
  })

  it('renders aria-checked=false for a paused job', () => {
    renderManagers([makeManager({ jobs: [makeJob({ enabled: false })] })])
    expect(getSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('marks a capped run count as a lower bound', () => {
    renderManagers([
      makeManager({ jobs: [makeJob({ runCount: 10_000, runCountSaturated: true })] })
    ])
    expect(container.textContent).toContain('10000+ runs found')
  })

  it('dispatches pause when toggling an enabled job', () => {
    const manager = makeManager({ jobs: [makeJob({ enabled: true })] })
    const { onAction } = renderManagers([manager])
    act(() => {
      getSwitch().click()
    })
    expect(onAction).toHaveBeenCalledWith(manager, manager.jobs[0], 'pause')
  })

  it('dispatches resume when toggling a paused job', () => {
    const manager = makeManager({ jobs: [makeJob({ enabled: false })] })
    const { onAction } = renderManagers([manager])
    act(() => {
      getSwitch().click()
    })
    expect(onAction).toHaveBeenCalledWith(manager, manager.jobs[0], 'resume')
  })

  it('disables the switch when the manager cannot be managed', () => {
    renderManagers([makeManager({ canManage: false })])
    expect(getSwitch().disabled).toBe(true)
  })

  it('shows the sibling spinner only while a pause/resume targets this row', () => {
    const manager = makeManager({ jobs: [makeJob({ id: 'job-1', enabled: true })] })
    // Keyed for the resume action even though the job is enabled — the spinner
    // must match either pause or resume so it does not vanish when enabled flips.
    renderManagers([manager], { runningActionKey: 'manager-1:job-1:resume' })
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('keeps the Run/Edit/Delete actions and removes the pause/resume button on hermes', () => {
    renderManagers([makeManager({ provider: 'hermes' })])
    const labels = actionButtonLabels()
    expect(labels).toContain('Run external automation')
    expect(labels).toContain('Edit external automation')
    expect(labels).toContain('Delete external automation')
    expect(labels).not.toContain('Pause external automation')
    expect(labels).not.toContain('Resume external automation')
  })

  it('keeps Run/Delete (no Edit) for openclaw and removes the pause/resume button', () => {
    renderManagers([makeManager({ provider: 'openclaw' })])
    const labels = actionButtonLabels()
    expect(labels).toContain('Run external automation')
    expect(labels).toContain('Delete external automation')
    expect(labels).not.toContain('Edit external automation')
    expect(labels).not.toContain('Pause external automation')
    expect(labels).not.toContain('Resume external automation')
  })
})
