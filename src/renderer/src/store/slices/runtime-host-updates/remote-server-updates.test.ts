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
  const list = vi.fn().mockResolvedValue([publicRuntimeEnvironment({ id: HOST })])
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        list,
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
      }) as unknown as AppState
  )
  return { state: store.getState, call, list }
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

it('rejects a previously shown update after a newer catalog read fails', async () => {
  const { state, call, list } = setup()
  const shownCheck = await state().refreshRemoteServerUpdates()
  const unavailable = new Error('Fixture catalog unavailable')
  list.mockRejectedValueOnce(unavailable)
  await expect(state().refreshRemoteServerUpdates()).rejects.toBe(unavailable)
  expect(state().remoteServerUpdates.get(HOST)?.targetVersion).toBe('1.4.276')

  await state().startRemoteServerUpdates([HOST], shownCheck)
  expect(call).not.toHaveBeenCalled()
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

it('uses the displayed stable target when recovery re-checks after a failed one-off RC update', async () => {
  const { state, call } = setup()
  call.mockResolvedValueOnce({
    ok: true,
    result: { status: { state: 'available', version: '1.4.277-rc.1' } }
  })
  const oneOff = await state().refreshRemoteServerUpdates({ includePrerelease: true })
  await state().startRemoteServerUpdates([HOST], oneOff)
  expect(state().remoteServerUpdates.get(HOST)).toMatchObject({
    phase: 'failed',
    targetVersion: '1.4.277-rc.1'
  })

  state().setRemoteServerUpdateDialogOpen(true)
  await state().refreshRemoteServerUpdates()
  expect(state().remoteServerUpdates.get(HOST)?.targetVersion).toBe('1.4.276')

  call.mockClear()
  await state().startRemoteServerUpdates([HOST])
  expect(call).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: 'updater.check',
      params: { includePrerelease: false, includePerfPrerelease: false }
    })
  )
})

it('keeps a stable recovery target on its original track after both re-checks fail', async () => {
  const { state, call, list } = setup()
  const stable = await state().refreshRemoteServerUpdates()
  await state().startRemoteServerUpdates([HOST], stable)
  expect(state().remoteServerUpdates.get(HOST)).toMatchObject({
    phase: 'failed',
    targetVersion: '1.4.276'
  })

  const unavailable = new Error('Fixture catalog unavailable')
  list.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable)
  await expect(state().refreshRemoteServerUpdates({ includePrerelease: true })).rejects.toBe(
    unavailable
  )
  state().setRemoteServerUpdateDialogOpen(true)
  await expect(state().refreshRemoteServerUpdates()).rejects.toBe(unavailable)
  expect(state().remoteServerUpdates.get(HOST)?.targetVersion).toBe('1.4.276')

  call.mockClear()
  await state().startRemoteServerUpdates([HOST])
  expect(call).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: 'updater.check',
      params: { includePrerelease: false, includePerfPrerelease: false }
    })
  )
})
