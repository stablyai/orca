// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CrossMachineRecoveryProviderApi } from '../../../../shared/cross-machine-recovery-provider-ipc'
import { TooltipProvider } from '../ui/tooltip'
import { CrossMachineRecoveryDialog } from './CrossMachineRecoveryDialog'
import {
  consumeCrossMachineRecoveryDialogRequest,
  requestCrossMachineRecoveryDialog
} from './cross-machine-recovery-dialog-request'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { CcSyncItem } from '../../../../shared/cross-machine-recovery-provider-types'
import {
  _resetCrossMachineRecoverySnapshot,
  refreshCrossMachineRecovery
} from './cross-machine-recovery-provider-store'
import { recoveryTestItem } from './cross-machine-recovery-test-items'

const activate = vi.hoisted(() => vi.fn(() => ({ primaryTabId: null })))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: activate }))
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError, warning: vi.fn() } }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const items = [
  recoveryTestItem({
    host: 'laptop',
    workspace: 'ready',
    sessions: [
      { id: 'recent', human: '2026-09-26T00:00:00Z' },
      { id: 'older', human: '2026-09-25T00:00:00Z' },
      { id: 'live', human: '2026-09-26T01:00:00Z', collision: true }
    ]
  }),
  recoveryTestItem({
    host: 'laptop',
    workspace: 'blocked',
    ready: false,
    missing: ['transcript'],
    sessions: []
  }),
  recoveryTestItem({
    host: 'laptop',
    workspace: 'other',
    sessions: [{ id: 'elsewhere', human: '2026-09-24T00:00:00Z' }]
  })
]

function listResult(listed: CcSyncItem[]) {
  return {
    ok: true,
    value: {
      version: 1,
      ok: true,
      generated_at: '2026-09-26T02:00:00Z',
      local: { host_id: 'me', host_name: 'studio-mac' },
      items: listed
    }
  } as const
}

const divergentFailure = {
  ok: false,
  error: {
    code: 'divergent-local-copy',
    message: 'local copy is newer',
    details: {
      session_id: 'recent',
      local_last_activity_at: '2026-09-26T03:00:00Z',
      picked_captured_at: '2026-09-26T00:00:00Z'
    }
  }
} as const

const bridge = {
  isSupported: true,
  status: vi.fn(async () => ({ ok: false, error: { code: 'timeout', message: 'slow' } })),
  list: vi.fn(async () => listResult(items)),
  inspect: vi.fn(),
  pickup: vi.fn<CrossMachineRecoveryProviderApi['pickup']>(async () => ({
    ok: true,
    value: {
      version: 1,
      ok: true,
      checkout: { path: '/w', branch: 'main', reused: false },
      sessions: [],
      orca: { execution_host_id: 'local', worktree_id: 'wt-recovered', resumed: [], dormant: [] }
    }
  })),
  cancel: vi.fn(),
  onPickupProgress: vi.fn(() => () => {})
}
const runtimeCall = vi.fn()
const runtimeEnvironmentsCall = vi.fn()

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      crossMachineRecovery: bridge,
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentsCall }
    }
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-remote' }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  consumeCrossMachineRecoveryDialogRequest()
  _resetCrossMachineRecoverySnapshot()
  vi.clearAllMocks()
  vi.useRealTimers()
})

async function openDialog(): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CrossMachineRecoveryDialog />
      </TooltipProvider>
    )
  )
  await act(async () => requestCrossMachineRecoveryDialog())
  await act(async () => {})
}

function itemRow(name: string): HTMLElement {
  const row = [
    ...document.querySelectorAll<HTMLElement>('[data-testid="cross-machine-recovery-item"]')
  ].find((element) => element.textContent?.includes(name))
  if (!row) {
    throw new Error(`no row ${name}`)
  }
  return row
}

function divergencePrompt(): Element | null {
  return document.querySelector('[data-testid="cross-machine-recovery-divergence"]')
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((button) => button.textContent === label)
}

it('renders local-destination rows with disabled reasons even while a remote environment is active', async () => {
  await openDialog()
  expect(
    document.querySelector('[data-testid="cross-machine-recovery-destination"]')?.textContent
  ).toBe('Recovers to this computer (studio-mac)')
  expect(document.body.textContent).toContain('laptop-name')
  const ready = itemRow('ready-name')
  expect(ready.textContent).toContain('orca · main')
  expect(ready.textContent).toContain('3 sessions')
  const blocked = itemRow('blocked-name')
  expect(blocked.getAttribute('aria-disabled')).toBe('true')
  expect(blocked.textContent).toContain('Not ready: missing transcript')
})

it('defaults resume to the most recent human session and disables the live-local collision', async () => {
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  const boxes = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="cross-machine-recovery-session"] button[role="checkbox"]'
    )
  ]
  const state = Object.fromEntries(
    boxes.map((box) => [
      box.getAttribute('aria-label'),
      { checked: box.getAttribute('aria-checked'), disabled: box.disabled }
    ])
  )
  expect(state).toEqual({
    live: { checked: 'false', disabled: true },
    recent: { checked: 'true', disabled: false },
    older: { checked: 'false', disabled: false }
  })
})

it('picks up through the desktop bridge only and reveals the local worktree', async () => {
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  await act(async () => buttonLabelled('Recover')?.click())
  expect(bridge.pickup).toHaveBeenCalledWith(
    expect.objectContaining({ selector: 'laptop/ready', resume: ['recent'] })
  )
  expect(runtimeCall).not.toHaveBeenCalled()
  expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  expect(activate).toHaveBeenCalledWith('wt-recovered', { executionHostId: 'local' })
})

it('offers keep-local/replace/fork on a divergent local copy and re-runs pickup with the choice', async () => {
  bridge.pickup.mockResolvedValueOnce({
    ok: false,
    error: {
      code: 'divergent-local-copy',
      message: 'local copy is newer',
      details: {
        session_id: 'recent',
        local_last_activity_at: '2026-09-26T03:00:00Z',
        picked_captured_at: '2026-09-26T00:00:00Z'
      }
    }
  })
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  await act(async () => buttonLabelled('Recover')?.click())
  expect(activate).not.toHaveBeenCalled()
  const prompt = document.querySelector('[data-testid="cross-machine-recovery-divergence"]')
  expect(prompt?.textContent).toContain('newer local copy of session recent')
  expect(
    [...(prompt?.querySelectorAll('button') ?? [])].map((button) => button.textContent)
  ).toEqual(['Keep local', 'Replace local', 'Fork as new session'])
  await act(async () => buttonLabelled('Fork as new session')?.click())
  expect(bridge.pickup).toHaveBeenCalledTimes(2)
  expect(bridge.pickup.mock.calls[0][0]).not.toHaveProperty('onDivergence')
  expect(bridge.pickup.mock.calls[1][0]).toEqual(
    expect.objectContaining({ selector: 'laptop/ready', resume: ['recent'], onDivergence: 'fork' })
  )
  expect(document.querySelector('[data-testid="cross-machine-recovery-divergence"]')).toBeNull()
  expect(activate).toHaveBeenCalledWith('wt-recovered', { executionHostId: 'local' })
})

it('drops the divergence prompt when another workspace is selected', async () => {
  bridge.pickup.mockResolvedValueOnce(divergentFailure)
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  await act(async () => buttonLabelled('Recover')?.click())
  expect(divergencePrompt()?.textContent).toContain('newer local copy of session recent')
  await act(async () => itemRow('other-name').click())
  expect(divergencePrompt()).toBeNull()
  expect(buttonLabelled('Replace local')).toBeUndefined()
  expect(bridge.pickup).toHaveBeenCalledTimes(1)
})

it('re-runs exactly the request that diverged even after the list refreshes', async () => {
  bridge.pickup.mockResolvedValueOnce(divergentFailure)
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  await act(async () => buttonLabelled('Recover')?.click())
  bridge.list.mockResolvedValueOnce(
    listResult([
      recoveryTestItem({
        host: 'laptop',
        workspace: 'ready',
        sessions: [
          { id: 'recent', human: '2026-09-20T00:00:00Z' },
          { id: 'older', human: '2026-09-26T05:00:00Z' }
        ]
      })
    ])
  )
  await act(async () => refreshCrossMachineRecovery())
  await act(async () => buttonLabelled('Replace local')?.click())
  expect(bridge.pickup).toHaveBeenCalledTimes(2)
  expect(bridge.pickup.mock.calls[1][0]).toEqual({
    operationId: expect.any(String),
    selector: 'laptop/ready',
    resume: ['recent'],
    onDivergence: 'replace'
  })
})

function deferPickup(): (result: typeof divergentFailure) => Promise<void> {
  let resolve: (result: typeof divergentFailure) => void = () => {}
  bridge.pickup.mockImplementationOnce(
    () =>
      new Promise((resolvePickup) => {
        resolve = resolvePickup
      })
  )
  return async (result) => act(async () => resolve(result))
}

function sessionCheckbox(sessionId: string): HTMLButtonElement {
  const box = document.querySelector<HTMLButtonElement>(
    `[data-testid="cross-machine-recovery-session"] button[role="checkbox"][aria-label="${sessionId}"]`
  )
  if (!box) {
    throw new Error(`no checkbox ${sessionId}`)
  }
  return box
}

it('ignores a divergence answer for a resume selection changed while pickup ran', async () => {
  const finishPickup = deferPickup()
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  await act(async () => buttonLabelled('Recover')?.click())
  await act(async () => sessionCheckbox('recent').click())
  expect(sessionCheckbox('recent').getAttribute('aria-checked')).toBe('false')

  await finishPickup(divergentFailure)

  expect(divergencePrompt()).toBeNull()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(toastError).toHaveBeenCalledWith('local copy is newer')
  await act(async () => buttonLabelled('Recover')?.click())
  expect(bridge.pickup).toHaveBeenCalledTimes(2)
  expect(bridge.pickup.mock.calls[1][0]).toEqual(
    expect.objectContaining({ selector: 'laptop/ready', resume: [] })
  )
})

it('ignores a divergence answer after another workspace is selected while pickup ran', async () => {
  const finishPickup = deferPickup()
  await openDialog()
  await act(async () => itemRow('ready-name').click())
  await act(async () => buttonLabelled('Recover')?.click())
  await act(async () => itemRow('other-name').click())

  await finishPickup(divergentFailure)

  expect(divergencePrompt()).toBeNull()
  expect(buttonLabelled('Replace local')).toBeUndefined()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(toastError).toHaveBeenCalledTimes(1)
  expect(bridge.pickup).toHaveBeenCalledTimes(1)
})

it('shows a newer partial checkpoint and the sessions it cannot recover', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-26T20:00:00Z'))
  bridge.list.mockResolvedValueOnce(
    listResult([
      recoveryTestItem({
        host: 'laptop',
        workspace: 'mixed',
        sessions: [{ id: 'claude-1', human: '2026-09-26T18:29:00Z' }],
        newerPartial: {
          id: 'cp-new',
          captured_at: '2026-09-26T19:50:00Z',
          session_activity_at: '2026-09-26T19:49:00Z',
          code_captured_at: '2026-09-26T19:10:00Z'
        },
        notRestorable: [
          { agent: 'codex', key: 'session_id', id: 'codex-1', reason: 'agent-not-supported-v1' },
          { agent: 'gemini', key: 'session_id', id: 'gem-1', reason: 'future-reason' }
        ]
      })
    ])
  )
  await openDialog()
  const row = itemRow('mixed-name')
  expect(
    row.querySelector('[data-testid="cross-machine-recovery-newer-partial"]')?.textContent
  ).toBe(
    `Newer partial checkpoint not recovered · sessions from ${formatUiRelativeTime(-11 * 60_000)} · code from ${formatUiRelativeTime(-50 * 60_000)}`
  )
  expect(
    row.querySelector('[data-testid="cross-machine-recovery-not-restorable"]')?.textContent
  ).toBe(
    "Can't recover here: codex codex-1 (agent not supported yet), gemini gem-1 (future-reason)"
  )
})
