// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { TooltipProvider } from '../ui/tooltip'
import { CrossMachineRecoveryDialog } from './CrossMachineRecoveryDialog'
import {
  consumeCrossMachineRecoveryDialogRequest,
  requestCrossMachineRecoveryDialog
} from './cross-machine-recovery-dialog-request'
import { _resetCrossMachineRecoverySnapshot } from './cross-machine-recovery-provider-store'
import { recoveryTestItem } from './cross-machine-recovery-test-items'

const activate = vi.hoisted(() => vi.fn(() => ({ primaryTabId: null })))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: activate }))

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
  })
]

const bridge = {
  isSupported: true,
  getClientInstanceId: vi.fn(async () => 'client-1'),
  status: vi.fn(async () => ({ ok: false, error: { code: 'timeout', message: 'slow' } })),
  list: vi.fn(async () => ({
    ok: true,
    value: {
      version: 1,
      ok: true,
      generated_at: '2026-09-26T02:00:00Z',
      local: { host_id: 'me', host_name: 'studio-mac' },
      items
    }
  })),
  inspect: vi.fn(),
  pickup: vi.fn(async () => ({
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
  const recover = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Recover'
  )
  await act(async () => recover?.click())
  expect(bridge.pickup).toHaveBeenCalledWith(
    expect.objectContaining({ selector: 'laptop/ready', resume: ['recent'] })
  )
  expect(runtimeCall).not.toHaveBeenCalled()
  expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  expect(activate).toHaveBeenCalledWith('wt-recovered', { executionHostId: 'local' })
})
