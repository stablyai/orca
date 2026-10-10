// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import { codexCliInstallation } from '../../../shared/codex-cli-installation'
import type { CodexMaintenanceState } from '../../../shared/codex-cli-maintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import {
  openCodexMaintenanceLog,
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from '@/lib/codex-maintenance-store'
import { CodexMaintenanceLogDialog } from '@/components/native-chat/CodexMaintenanceLogDialog'
import { useCodexMaintenance } from './useCodexMaintenance'

type SettingsState = { settings: GlobalSettings | null }
const mocks = vi.hoisted(() => {
  const state: SettingsState = { settings: null }
  return {
    state,
    call: vi.fn(),
    listeners: new Set<(state: SettingsState, previous: SettingsState) => void>()
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: (listener: (state: SettingsState, previous: SettingsState) => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/codex-maintenance-host-contact', () => ({
  codexMaintenanceHostIsReachable: () => true,
  subscribeCodexMaintenanceHostContact: () => () => {}
}))
vi.mock('@/lib/codex-maintenance-client', () => ({
  callCodexMaintenance: mocks.call,
  codexMaintenanceTargetKey: (target: CodexMaintenanceTarget) =>
    target.kind === 'environment' ? `runtime:${target.environmentId}` : 'local:codex'
}))
const LOCAL = { kind: 'local' } as const
function state(
  version = '0.135.0',
  expiresAt = Date.now() + 30_000,
  configurationId = 'old'
): CodexMaintenanceState {
  return {
    installation: codexCliInstallation(true, version),
    canRun: false,
    job: null,
    evidence: { expiresAt, configurationId }
  }
}
function Surface({ target = LOCAL }: { target?: CodexMaintenanceTarget }) {
  const result = useCodexMaintenance(target)
  return <button disabled={result.blocked}>{result.installation?.version ?? 'unknown'}</button>
}
function publish(settings: GlobalSettings): void {
  const previous = { ...mocks.state }
  mocks.state.settings = settings
  for (const listener of mocks.listeners) {
    listener(mocks.state, previous)
  }
}
beforeEach(() => {
  resetCodexMaintenanceStoreForTests()
  mocks.call.mockReset()
  mocks.state.settings = getDefaultSettings('/test')
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => {
  cleanup()
  resetCodexMaintenanceStoreForTests()
  vi.useRealTimers()
  expect(mocks.listeners.size).toBe(0)
})
it.each([LOCAL, { kind: 'environment', environmentId: 'paired' } as const])(
  'rechecks mounted $kind surfaces for command and environment publications and fences old replies',
  async (target) => {
    mocks.call.mockResolvedValueOnce(state())
    render(<Surface target={target} />)
    await act(async () => {
      await refreshCodexMaintenance(target)
    })
    expect(screen.getByRole('button')).toBeDisabled()
    let completeOld: (value: CodexMaintenanceState) => void = () => {}
    mocks.call.mockImplementationOnce(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          completeOld = resolve
        })
    )
    act(() =>
      publish({ ...getDefaultSettings('/test'), agentCmdOverrides: { codex: '/working/codex' } })
    )
    expect(screen.getByRole('button')).toBeEnabled()
    mocks.call.mockResolvedValueOnce(state('0.136.0', 30_000, 'new'))
    await act(async () => {
      publish({
        ...getDefaultSettings('/test'),
        agentCmdOverrides: { codex: '/working/codex' },
        agentDefaultEnv: { codex: { PATH: '/correct/path', TOKEN: 'private' } }
      })
      await refreshCodexMaintenance(target)
      completeOld(state())
    })
    expect(mocks.call).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button')).toHaveTextContent('0.136.0')
    expect(screen.getByRole('button')).toBeEnabled()
    act(() =>
      publish({
        ...mocks.state.settings,
        ...getDefaultSettings('/test'),
        agentCmdOverrides: { codex: '/working/codex' },
        agentDefaultEnv: { codex: { PATH: '/correct/path', TOKEN: 'private' } }
      })
    )
    expect(mocks.call).toHaveBeenCalledTimes(3)
  }
)
it('rechecks at the host expiry after an external shim update and a focus refresh just before expiry', async () => {
  const cached = state()
  mocks.call.mockResolvedValue(cached)
  const view = render(
    <>
      <Surface />
      <Surface />
    </>
  )
  await act(async () => {
    await refreshCodexMaintenance(LOCAL)
  })
  expect(mocks.call).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_999)
  })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await refreshCodexMaintenance(LOCAL)
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  mocks.call.mockResolvedValue(state('0.136.0', 60_000, 'old'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(mocks.call).toHaveBeenCalledTimes(3)
  expect(screen.getAllByRole('button').every((button) => !button.hasAttribute('disabled'))).toBe(
    true
  )
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.call).toHaveBeenCalledTimes(3)
})
it('withdraws expired and legacy evidence without a retry loop or blocking', async () => {
  const legacy = state()
  delete legacy.evidence
  mocks.call.mockResolvedValue(legacy)
  render(<Surface />)
  await act(async () => {
    await refreshCodexMaintenance(LOCAL)
  })
  expect(screen.getByRole('button')).toHaveTextContent('unknown')
  expect(screen.getByRole('button')).toBeEnabled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(mocks.call).toHaveBeenCalledTimes(1)
  mocks.call.mockResolvedValue(state('0.135.0', Date.now() - 1))
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await refreshCodexMaintenance(LOCAL)
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button')).toBeEnabled()
})

it('bounds a paired host expiry despite clock skew and time spent awaiting the reply', async () => {
  const target = { kind: 'environment', environmentId: 'paired' } as const
  let complete: (value: CodexMaintenanceState) => void = () => {}
  mocks.call.mockImplementationOnce(
    () =>
      new Promise<CodexMaintenanceState>((resolve) => {
        complete = resolve
      })
  )
  render(<Surface target={target} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  await act(async () => {
    complete({
      ...state('0.135.0', 1_030_000),
      evidence: { expiresAt: 1_030_000, observedAt: 1_000_000, configurationId: 'remote' }
    })
  })
  expect(screen.getByRole('button')).toBeDisabled()
  mocks.call.mockResolvedValue(state('0.136.0', 60_000))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_000)
  })
  expect(mocks.call).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button')).toBeEnabled()
})
it('keeps the historical output without displaying running activity after the host loses that job', async () => {
  const initial = state()
  initial.job = {
    id: 'old',
    phase: 'running',
    output: 'old log',
    exitCode: null,
    error: null
  }
  mocks.call.mockResolvedValue(initial)
  render(
    <>
      <Surface />
      <CodexMaintenanceLogDialog />
    </>
  )
  await act(async () => {
    await refreshCodexMaintenance(LOCAL)
    openCodexMaintenanceLog(LOCAL)
  })
  expect(screen.getByText('Installing…')).toBeInTheDocument()
  mocks.call.mockResolvedValue(state())
  await act(async () => {
    await refreshCodexMaintenance(LOCAL)
  })
  expect(screen.getByText('old log')).toBeInTheDocument()
  expect(screen.queryByText('Installing…')).toBeNull()
  expect(screen.getByText('npm install -g @openai/codex')).toBeInTheDocument()
})
