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
})
