// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { ManagedOrcadServerRow } from './ManagedOrcadServerRow'
import { cancelManagedOrcadStopFromSettings } from './managed-orcad-stop-cancellation'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each(['prepared', 'admission-fenced', 'process-exited'] as const)(
  'offers cancellation only for prepared stops (%s)',
  (phase) => {
    const onCancelStop = vi.fn()
    const onRecover = vi.fn()
    const { rerender } = render(
      <ManagedOrcadServerRow
        environment={{ id: 'host', name: 'Host' } as PublicKnownRuntimeEnvironment}
        busyAction={null}
        isActive={false}
        onCancelStop={onCancelStop}
        onRecover={onRecover}
        onConfirm={vi.fn()}
        onResume={vi.fn()}
        onUpdate={vi.fn()}
        statusEntry={{
          state: 'ready',
          status: {
            environmentId: 'host',
            sshTargetId: 'ssh',
            activeVersion: '1.0',
            previousVersion: null,
            activatedAt: null,
            rollbackAvailable: false,
            recovery: { operation: 'decommission', phase, version: '1.0', startedAt: 'now' }
          }
        }}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry Stop' })).toBeTruthy()
    if (phase === 'prepared') {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel Stop' }))
      expect(onCancelStop).toHaveBeenCalledOnce()
      expect(onRecover).not.toHaveBeenCalled()
    } else {
      expect(screen.queryByRole('button', { name: 'Cancel Stop' })).toBeNull()
    }
    const props = {
      environment: { id: 'host', name: 'Host' } as PublicKnownRuntimeEnvironment,
      busyAction: null,
      isActive: true,
      onCancelStop,
      onRecover,
      onConfirm: vi.fn(),
      onResume: vi.fn(),
      onUpdate: vi.fn(),
      statusEntry: {
        state: 'ready' as const,
        status: {
          environmentId: 'host',
          sshTargetId: 'ssh',
          activeVersion: '1.0',
          previousVersion: null,
          activatedAt: null,
          rollbackAvailable: false,
          recovery: { operation: 'decommission' as const, phase, version: '1.0', startedAt: 'now' }
        }
      }
    }
    rerender(<ManagedOrcadServerRow {...props} />)
    expect((screen.getByRole('button', { name: 'Retry Stop' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    if (phase === 'prepared') {
      expect(
        (screen.getByRole('button', { name: 'Cancel Stop' }) as HTMLButtonElement).disabled
      ).toBe(false)
    }
  }
)

it.each(['canceled', 'none', 'pending', 'refused'] as const)(
  'reports %s without claiming unconfirmed cancellation',
  async (outcome) => {
    const cancel = vi.fn().mockResolvedValue({ outcome, reason: 'Host not verified' })
    Object.assign(window, { api: { runtimeEnvironments: { cancelOrcadStop: cancel } } })
    const actions = {
      setBusyAction: vi.fn(),
      clearRowError: vi.fn(),
      setRowError: vi.fn(),
      refreshAfterMutation: vi.fn().mockResolvedValue(undefined)
    }
    await cancelManagedOrcadStopFromSettings('host', actions)
    expect(cancel).toHaveBeenCalledWith({ selector: 'host' })
    expect(actions.setBusyAction).toHaveBeenNthCalledWith(1, { id: 'host', action: 'cancel-stop' })
    expect(actions.setBusyAction).toHaveBeenLastCalledWith(null)
    if (outcome === 'canceled') {
      expect(toast.success).toHaveBeenCalledOnce()
      expect(actions.refreshAfterMutation).toHaveBeenCalledOnce()
    } else {
      expect(toast.success).not.toHaveBeenCalled()
      expect(actions.setRowError).toHaveBeenCalled()
    }
  }
)
