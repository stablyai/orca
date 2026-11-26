import { afterEach, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  REMOTE_SERVER_UPDATE_CAPABILITY,
  type RemoteServerUpdateSupport
} from '../../../../../shared/remote-runtime/host-catalog/remote-server-update'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { AppState } from '../../types'
import { createRemoteServerUpdatesSlice } from './remote-server-updates'

const HOST = 'fixture-host'
const SUPPORT: RemoteServerUpdateSupport = {
  automatic: true,
  installMode: 'interactive',
  reason: 'available'
}

function setup() {
  const response = createCompatibleRuntimeStatusResponse()
  const call = vi.fn().mockRejectedValue(new Error('Fixture download unavailable'))
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        list: async () => [publicRuntimeEnvironment({ id: HOST })],
        getStatus: async () => ({
          ...response,
          result: {
            ...response.result,
            appVersion: '1.4.270',
            capabilities: [REMOTE_SERVER_UPDATE_CAPABILITY],
            remoteUpdateSupport: SUPPORT
          }
        }),
        call
      },
      updater: { getVersion: async () => '1.4.276' }
    }
  })
  const store = createStore<AppState>()(
    (...args) =>
      ({
        ...createRemoteServerUpdatesSlice(...args),
        setRuntimeEnvironments: () => {}
      }) as AppState
  )
  return { state: store.getState, call }
}

afterEach(() => vi.unstubAllGlobals())

it('rejects a superseded check and runs the current check’s track without inheriting a one-off RC', async () => {
  const { state, call } = setup()
  call.mockResolvedValueOnce({
    ok: true,
    result: { status: { state: 'available', version: '1.4.277-rc.1' } }
  })
  const oneOff = await state().refreshRemoteServerUpdates({ includePrerelease: true })
  const defaultCheck = await state().refreshRemoteServerUpdates()
  call.mockClear()

  await state().startRemoteServerUpdates([HOST], oneOff)
  expect(call).not.toHaveBeenCalled()

  await state().startRemoteServerUpdates([HOST], defaultCheck)
  expect(call).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: 'updater.check',
      params: { includePrerelease: false, includePerfPrerelease: false }
    })
  )
})

it('keeps the failure from a completed batch on a passive re-check of the same target', async () => {
  const { state } = setup()
  const check = await state().refreshRemoteServerUpdates()
  await state().startRemoteServerUpdates([HOST], check)
  expect(state().remoteServerUpdates.get(HOST)?.phase).toBe('failed')

  await state().refreshRemoteServerUpdates(undefined, { preserveFailureDetails: true })
  expect(state().remoteServerUpdates.get(HOST)).toMatchObject({
    phase: 'failed',
    targetVersion: '1.4.276',
    error: 'Fixture download unavailable'
  })

  await state().refreshRemoteServerUpdates()
  expect(state().remoteServerUpdates.get(HOST)).toMatchObject({ phase: 'available', error: null })
})
