// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

const { toastSuccess, toastError, toastWarning } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError, warning: toastWarning }
}))

import { useRuntimeEnvironmentMutationActions } from './use-runtime-environment-mutation-actions'
import { getDefaultSettings } from '../../../../shared/constants'

const verifyAndAddFromPairingCode = vi.fn()
const remove = vi.fn()

const saved: PublicKnownRuntimeEnvironment = {
  id: 'env-studio',
  name: 'Studio',
  createdAt: 1,
  updatedAt: 2,
  lastUsedAt: null,
  runtimeId: 'runtime-a',
  endpoints: [{ id: 'ws-env-studio', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
  preferredEndpointId: 'ws-env-studio'
}

beforeEach(() => {
  toastSuccess.mockReset()
  toastError.mockReset()
  toastWarning.mockReset()
  verifyAndAddFromPairingCode.mockReset()
  remove.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtimeEnvironments: { verifyAndAddFromPairingCode, remove } }
  })
})
afterEach(() => cleanup())

function renderActions(connectEnvironment: () => Promise<boolean>, name = 'Studio over relay') {
  const view = renderHook(() =>
    useRuntimeEnvironmentMutationActions({
      settings: getDefaultSettings('/tmp'),
      allowLocalRuntime: false,
      mountedRef: { current: true },
      setAddServerFormOpen: vi.fn(),
      loadEnvironments: vi.fn(async () => {}),
      connectEnvironment
    })
  )
  act(() => {
    view.result.current.setName(name)
    view.result.current.setPairingCode('orca://pair#code')
  })
  return view
}

it('keeps a refreshed saved server when the follow-up connect fails, and says which one it was', async () => {
  verifyAndAddFromPairingCode.mockResolvedValue({
    ok: true,
    environment: saved,
    runtimeStatus: { runtimeId: 'runtime-a' },
    updatedExisting: true
  })
  const view = renderActions(async () => false)

  await act(async () => {
    await view.result.current.addEnvironment(false)
  })

  expect(remove).not.toHaveBeenCalled()
  expect(toastSuccess).toHaveBeenCalledWith(
    'This server is already paired as Studio; updated its connection.'
  )
})

it('still discards a brand-new server whose first connect fails', async () => {
  verifyAndAddFromPairingCode.mockResolvedValue({
    ok: true,
    environment: { ...saved, id: 'env-new', name: 'Laptop' },
    runtimeStatus: { runtimeId: 'runtime-b' }
  })
  const view = renderActions(async () => false)

  await act(async () => {
    await view.result.current.addEnvironment(false)
  })

  expect(remove).toHaveBeenCalledWith({ selector: 'env-new' })
})
