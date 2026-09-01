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
import type {
  ExternalAutomationScope,
  ScopedExternalAutomationManager
} from './external-automation-scope-client'
import { externalAutomationActionKey } from './external-automation-scope-keys'

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

/** The desktop-self host every manager here is discovered on unless named otherwise. */
function makeScope(environmentId: string | null = null): ExternalAutomationScope {
  return {
    owner: {
      authority:
        environmentId === null
          ? { kind: 'desktop' }
          : { kind: 'runtime', environmentId, pairingRevision: 1 },
      selector: { kind: 'self' }
    },
    provider: 'hermes'
  }
}

function scoped(
  overrides: Partial<ExternalAutomationManager> = {},
  scope: ExternalAutomationScope = makeScope()
): ScopedExternalAutomationManager {
  return { scope, manager: makeManager(overrides) }
}

type OnActionMock = ReturnType<
  typeof vi.fn<
    (
      manager: ExternalAutomationManager,
      job: ExternalAutomationJob,
      action: ExternalAutomationAction,
      scope: ExternalAutomationScope
    ) => void
  >
>
type OnEditMock = ReturnType<
  typeof vi.fn<
    (
      manager: ExternalAutomationManager,
      job: ExternalAutomationJob,
      scope: ExternalAutomationScope
    ) => void
  >
>

type RenderOptions = {
  runningActionKey?: string | null
  onAction?: OnActionMock
  onEdit?: OnEditMock
}

function renderManagers(
  managers: ScopedExternalAutomationManager[],
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

function getSwitch(index = 0): HTMLButtonElement {
  const node = container.querySelectorAll('button[role="switch"]')[index]
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`expected a role="switch" control at ${index}`)
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
    renderManagers([scoped({ jobs: [makeJob({ enabled: true })] })])
    expect(getSwitch().getAttribute('aria-checked')).toBe('true')
  })

  it('renders aria-checked=false for a paused job', () => {
    renderManagers([scoped({ jobs: [makeJob({ enabled: false })] })])
    expect(getSwitch().getAttribute('aria-checked')).toBe('false')
  })

  it('dispatches pause when toggling an enabled job', () => {
    const entry = scoped({ jobs: [makeJob({ enabled: true })] })
    const { onAction } = renderManagers([entry])
    act(() => {
      getSwitch().click()
    })
    expect(onAction).toHaveBeenCalledWith(
      entry.manager,
      entry.manager.jobs[0],
      'pause',
      entry.scope
    )
  })

  it('dispatches resume when toggling a paused job', () => {
    const entry = scoped({ jobs: [makeJob({ enabled: false })] })
    const { onAction } = renderManagers([entry])
    act(() => {
      getSwitch().click()
    })
    expect(onAction).toHaveBeenCalledWith(
      entry.manager,
      entry.manager.jobs[0],
      'resume',
      entry.scope
    )
  })

  it('disables the switch when the manager cannot be managed', () => {
    renderManagers([scoped({ canManage: false })])
    expect(getSwitch().disabled).toBe(true)
  })

  it('shows the sibling spinner only while a pause/resume targets this row', () => {
    const entry = scoped({ jobs: [makeJob({ id: 'job-1', enabled: true })] })
    // Keyed for the resume action even though the job is enabled — the spinner
    // must match either pause or resume so it does not vanish when enabled flips.
    renderManagers([entry], {
      runningActionKey: externalAutomationActionKey(entry.scope, 'job-1', 'resume')
    })
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('spins only the host whose action is in flight when two authorities share a manager ID', () => {
    // Both hosts report `hermes:local` with the same job ID, because that ID
    // names a provider and a target kind but no authority. The page keys the
    // in-flight action by scope, so the component must too — matching on
    // manager and job alone would spin the wrong host's row, and a user would
    // watch a machine they never touched appear to run their automation.
    const local = { id: 'hermes:local', jobs: [makeJob({ id: 'job-1', enabled: true })] }
    const desktop = scoped(local, makeScope())
    const runtime = scoped(local, makeScope('env-7'))

    renderManagers([desktop, runtime], {
      runningActionKey: externalAutomationActionKey(runtime.scope, 'job-1', 'pause')
    })

    // The spinner sits beside the switch it belongs to, so the switch it shares a
    // parent with is the row the component considers in flight.
    const spinners = container.querySelectorAll('.animate-spin')
    expect(spinners).toHaveLength(1)
    expect(spinners[0]?.parentElement?.contains(getSwitch(1))).toBe(true)
    expect(spinners[0]?.parentElement?.contains(getSwitch(0))).toBe(false)
  })

  it('labels the two rows apart when two authorities share a manager and job ID', () => {
    const local = { id: 'hermes:local', jobs: [makeJob({ id: 'job-1' })] }
    renderManagers([scoped(local, makeScope()), scoped(local, makeScope('env-7'))])

    // A name element ID built from manager and job alone would repeat, and the
    // second switch's aria-labelledby would resolve to the first host's name.
    expect(getSwitch(0).getAttribute('aria-labelledby')).not.toBe(
      getSwitch(1).getAttribute('aria-labelledby')
    )
  })

  it('dispatches each row against its own authority when two share a manager ID', () => {
    const local = { id: 'hermes:local', jobs: [makeJob({ id: 'job-1', enabled: true })] }
    const desktop = scoped(local, makeScope())
    const runtime = scoped(local, makeScope('env-7'))
    const { onAction } = renderManagers([desktop, runtime])

    act(() => {
      getSwitch(1).click()
    })

    // The scope reaches the handler from the row, so a pause on the runtime's
    // row can never be replayed against the desktop's identically named cron job.
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0]?.[3]).toEqual(runtime.scope)
  })

  it('keeps the Run/Edit/Delete actions and removes the pause/resume button on hermes', () => {
    renderManagers([scoped({ provider: 'hermes' })])
    const labels = actionButtonLabels()
    expect(labels).toContain('Run external automation')
    expect(labels).toContain('Edit external automation')
    expect(labels).toContain('Delete external automation')
    expect(labels).not.toContain('Pause external automation')
    expect(labels).not.toContain('Resume external automation')
  })

  it('keeps Run/Delete (no Edit) for openclaw and removes the pause/resume button', () => {
    renderManagers([scoped({ provider: 'openclaw' })])
    const labels = actionButtonLabels()
    expect(labels).toContain('Run external automation')
    expect(labels).toContain('Delete external automation')
    expect(labels).not.toContain('Edit external automation')
    expect(labels).not.toContain('Pause external automation')
    expect(labels).not.toContain('Resume external automation')
  })
})
