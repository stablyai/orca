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

// Enable React’s act environment for these renderer mounts.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Stub external run fetching to isolate row controls.
vi.mock('./ExternalAutomationRunTable', () => ({
  ExternalAutomationRunTable: () => <div data-testid="run-table" />
}))

// Stub TooltipProvider-dependent primitives so standalone row triggers stay inspectable.
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
    provider: 'openclaw',
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
  const provider: ExternalAutomationProvider = overrides.provider ?? 'openclaw'
  return {
    id: 'manager-1',
    provider,
    label: 'Local OpenClaw',
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
    provider: 'openclaw'
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
type RenderOptions = {
  runningActionKey?: string | null
  onAction?: OnActionMock
}

function renderManagers(
  managers: ScopedExternalAutomationManager[],
  options: RenderOptions = {}
): { onAction: OnActionMock } {
  const onAction = options.onAction ?? vi.fn()
  act(() => {
    root.render(
      <ExternalAutomationManagers
        managers={managers}
        now={0}
        runningActionKey={options.runningActionKey ?? null}
        onAction={onAction}
      />
    )
  })
  return { onAction }
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

  it('shows the sibling spinner for a matching resume key on an enabled row', () => {
    const entry = scoped({ jobs: [makeJob({ id: 'job-1', enabled: true })] })
    // Match both pause/resume keys because enabled can flip before the action settles.
    renderManagers([entry], {
      runningActionKey: externalAutomationActionKey(entry.scope, 'job-1', 'resume')
    })
    expect(container.querySelector('.animate-spin')).not.toBeNull()
  })

  it('spins only the host whose action is in flight when two authorities share a manager ID', () => {
    // Manager/job IDs collide across authorities; scope the in-flight key so another host cannot show this action’s spinner.
    const local = { id: 'openclaw:local', jobs: [makeJob({ id: 'job-1', enabled: true })] }
    const desktop = scoped(local, makeScope())
    const runtime = scoped(local, makeScope('env-7'))

    renderManagers([desktop, runtime], {
      runningActionKey: externalAutomationActionKey(runtime.scope, 'job-1', 'pause')
    })

    // The spinner’s sibling switch identifies which host row is in flight.
    const spinners = container.querySelectorAll('.animate-spin')
    expect(spinners).toHaveLength(1)
    expect(spinners[0]?.parentElement?.contains(getSwitch(1))).toBe(true)
    expect(spinners[0]?.parentElement?.contains(getSwitch(0))).toBe(false)
  })

  it('labels the two rows apart when two authorities share a manager and job ID', () => {
    const local = { id: 'openclaw:local', jobs: [makeJob({ id: 'job-1' })] }
    renderManagers([scoped(local, makeScope()), scoped(local, makeScope('env-7'))])

    // Scope name IDs too so aria-labelledby cannot resolve to another host’s row.
    expect(getSwitch(0).getAttribute('aria-labelledby')).not.toBe(
      getSwitch(1).getAttribute('aria-labelledby')
    )
  })

  it('dispatches each row against its own authority when two share a manager ID', () => {
    const local = { id: 'openclaw:local', jobs: [makeJob({ id: 'job-1', enabled: true })] }
    const desktop = scoped(local, makeScope())
    const runtime = scoped(local, makeScope('env-7'))
    const { onAction } = renderManagers([desktop, runtime])

    act(() => {
      getSwitch(1).click()
    })

    // Carry row scope into actions so matching remote/local job IDs cannot misroute pause.
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0]?.[3]).toEqual(runtime.scope)
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
