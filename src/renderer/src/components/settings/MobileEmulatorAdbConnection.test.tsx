// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MobileEmulatorAdbConnection } from './MobileEmulatorAdbConnection'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

type RuntimeCallRequest = { method: string; params?: unknown }
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function runtimeSuccess<T>(result: T) {
  return { id: 'test', ok: true, result, _meta: { runtimeId: 'test-runtime' } }
}

function runtimeFailure(code: string, message: string) {
  return { id: 'test', ok: false, error: { code, message }, _meta: { runtimeId: 'test-runtime' } }
}

type Settings = Pick<GlobalSettings, 'mobileEmulatorAdbAddress' | 'mobileEmulatorDefaultDeviceUdid'>

function renderConnection(
  settings: Settings,
  overrides: Partial<React.ComponentProps<typeof MobileEmulatorAdbConnection>> = {}
) {
  const updateSettings = vi.fn()
  const onAfterConnectionChange = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  const rendered = render(
    <MobileEmulatorAdbConnection
      settings={settings}
      updateSettings={updateSettings}
      onAfterConnectionChange={onAfterConnectionChange}
      {...overrides}
    />
  )
  return { ...rendered, user, updateSettings, onAfterConnectionChange }
}

describe('MobileEmulatorAdbConnection', () => {
  let callMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    callMock = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { call: callMock } }
    })
  })

  afterEach(() => cleanup())

  it('renders the saved address', async () => {
    callMock.mockResolvedValue(
      runtimeSuccess({ state: 'disconnected', address: null, serial: null })
    )
    renderConnection({
      mobileEmulatorAdbAddress: '192.168.1.50:5555',
      mobileEmulatorDefaultDeviceUdid: null
    })
    expect(screen.getByDisplayValue('192.168.1.50:5555')).toBeVisible()
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'emulator.adbConnectionStatus',
          params: { address: '192.168.1.50:5555' }
        })
      )
    )
  })

  it('connect flow success updates status and refreshes availability', async () => {
    callMock.mockImplementation(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.adbConnectionStatus') {
        return runtimeSuccess({ state: 'disconnected', address: null, serial: null })
      }
      if (method === 'emulator.adbConnect') {
        return runtimeSuccess({
          state: 'connected',
          address: '192.168.1.50:5555',
          serial: '192.168.1.50:5555'
        })
      }
      throw new Error(`unexpected method ${method}`)
    })
    const { user, onAfterConnectionChange } = renderConnection({
      mobileEmulatorAdbAddress: null,
      mobileEmulatorDefaultDeviceUdid: null
    })
    await waitFor(() => expect(screen.getByLabelText('Device address')).toBeEnabled())

    await user.type(screen.getByLabelText('Device address'), '192.168.1.50:5555')
    await user.click(screen.getByRole('button', { name: 'Connect' }))

    await waitFor(() => expect(screen.getByText('Connected')).toBeVisible())
    expect(onAfterConnectionChange).toHaveBeenCalled()
  })

  it('disables controls while an operation is in flight', async () => {
    const statusDeferred = createDeferred<unknown>()
    const connectDeferred = createDeferred<unknown>()
    callMock.mockImplementation(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.adbConnectionStatus') {
        return runtimeSuccess(await statusDeferred.promise)
      }
      if (method === 'emulator.adbConnect') {
        return runtimeSuccess(await connectDeferred.promise)
      }
      throw new Error(`unexpected method ${method}`)
    })
    statusDeferred.resolve({ state: 'disconnected', address: null, serial: null })
    const { user } = renderConnection({
      mobileEmulatorAdbAddress: '10.0.0.5:5555',
      mobileEmulatorDefaultDeviceUdid: null
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
    expect(screen.getByLabelText('Device address')).toBeDisabled()

    connectDeferred.resolve({
      state: 'connected',
      address: '10.0.0.5:5555',
      serial: '10.0.0.5:5555'
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled())
  })

  it('ignores a stale mount status response that resolves after a newer connect response', async () => {
    const statusDeferred = createDeferred<unknown>()
    callMock.mockImplementation(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.adbConnectionStatus') {
        return runtimeSuccess(await statusDeferred.promise)
      }
      if (method === 'emulator.adbConnect') {
        return runtimeSuccess({
          state: 'connected',
          address: '10.0.0.5:5555',
          serial: '10.0.0.5:5555'
        })
      }
      throw new Error(`unexpected method ${method}`)
    })
    const { user } = renderConnection({
      mobileEmulatorAdbAddress: '10.0.0.5:5555',
      mobileEmulatorDefaultDeviceUdid: null
    })

    // The mount status check is still pending; a Connect click resolves first.
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByText('Connected')).toBeVisible())

    // The stale mount status response now arrives — it must not clobber the
    // newer Connect result.
    statusDeferred.resolve({
      state: 'offline',
      address: '10.0.0.5:5555',
      serial: '10.0.0.5:5555',
      message: 'stale'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.getByText('Connected')).toBeVisible()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('shows RSA-key approval guidance for an unauthorized device', async () => {
    callMock.mockResolvedValue(
      runtimeSuccess({
        state: 'unauthorized',
        address: '10.0.0.5:5555',
        serial: '10.0.0.5:5555',
        message: 'Approve the RSA key prompt on the device, then try connecting again.',
        errorCode: 'emulator_adb_unauthorized'
      })
    )
    renderConnection({
      mobileEmulatorAdbAddress: '10.0.0.5:5555',
      mobileEmulatorDefaultDeviceUdid: null
    })
    await waitFor(() => expect(screen.getByText('Unauthorized')).toBeVisible())
    expect(screen.getByText(/Approve the RSA key prompt/i)).toBeVisible()
  })

  it('clears a default device matching the previous address even before status returns', async () => {
    const statusDeferred = createDeferred<unknown>()
    callMock.mockImplementation(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.adbConnectionStatus') {
        return runtimeSuccess(await statusDeferred.promise)
      }
      throw new Error(`unexpected method ${method}`)
    })
    const { user, updateSettings } = renderConnection({
      mobileEmulatorAdbAddress: '192.168.1.50:5555',
      mobileEmulatorDefaultDeviceUdid: '192.168.1.50:5555'
    })

    const input = screen.getByLabelText('Device address')
    await user.clear(input)
    await user.type(input, '10.0.0.8:5555')
    await user.tab()

    expect(updateSettings).toHaveBeenCalledWith({
      mobileEmulatorAdbAddress: '10.0.0.8:5555',
      mobileEmulatorDefaultDeviceUdid: null
    })

    statusDeferred.resolve({
      state: 'disconnected',
      address: '192.168.1.50:5555',
      serial: '192.168.1.50:5555'
    })
  })

  it('preserves an unrelated default device when replacing the address before status returns', async () => {
    const statusDeferred = createDeferred<unknown>()
    callMock.mockImplementation(async ({ method }: RuntimeCallRequest) => {
      if (method === 'emulator.adbConnectionStatus') {
        return runtimeSuccess(await statusDeferred.promise)
      }
      throw new Error(`unexpected method ${method}`)
    })
    const { user, updateSettings } = renderConnection({
      mobileEmulatorAdbAddress: '192.168.1.50:5555',
      mobileEmulatorDefaultDeviceUdid: 'emulator-5554'
    })

    const input = screen.getByLabelText('Device address')
    await user.clear(input)
    await user.type(input, '10.0.0.8:5555')
    await user.tab()

    expect(updateSettings).toHaveBeenCalledWith({
      mobileEmulatorAdbAddress: '10.0.0.8:5555'
    })

    statusDeferred.resolve({
      state: 'disconnected',
      address: '192.168.1.50:5555',
      serial: '192.168.1.50:5555'
    })
  })

  it('shows an unsupported note and no actionable buttons when the RPC method is unavailable', async () => {
    callMock.mockResolvedValue(
      runtimeFailure('method_not_found', 'Unknown method: emulator.adbConnectionStatus')
    )
    renderConnection({
      mobileEmulatorAdbAddress: '10.0.0.5:5555',
      mobileEmulatorDefaultDeviceUdid: null
    })
    await waitFor(() =>
      expect(
        screen.getByText('ADB device connection is not available from this client.')
      ).toBeVisible()
    )
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull()
  })
})
