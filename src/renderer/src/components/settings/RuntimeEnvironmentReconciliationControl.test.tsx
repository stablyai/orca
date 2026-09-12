// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { RuntimeEnvironmentReconciliationControl } from './RuntimeEnvironmentReconciliationControl'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  reconcile: vi.fn(),
  hydrate: vi.fn(),
  web: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setRuntimeEnvironments: mocks.hydrate }) }
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: mocks.web }))
let entries: PublicKnownRuntimeEnvironment[]
const savedRecord = (stage: 'prepared' | 'catalog-active') => ({
  version: 1 as const,
  stage,
  requestId: 'saved-request',
  canonicalEnvironmentId: 'left',
  runtimeId: 'host',
  preparedAt: 1,
  registrations: ['left', 'right'].map((environmentId) => ({
    environmentId,
    authorityDigest: 'a'.repeat(64)
  }))
})
const setStage = (stage: 'prepared' | 'catalog-active') => {
  entries = entries.map((entry) => ({ ...entry, reconciliation: savedRecord(stage) }))
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
async function choose(label: string, name: string) {
  const select = screen.getByRole('combobox', { name: label })
  await waitFor(() => expect((select as HTMLButtonElement).disabled).toBe(false))
  fireEvent.keyDown(select, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name }))
}
async function open() {
  render(<RuntimeEnvironmentReconciliationControl onChanged={vi.fn(async () => {})} />)
  fireEvent.click(button('Group server entries…'))
  await choose('Primary entry or saved group', 'left · left')
}
beforeEach(() => {
  vi.resetAllMocks()
  entries = ['left', 'right'].map((id) => ({
    id,
    name: id,
    runtimeId: 'host',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    preferredEndpointId: 'direct',
    endpoints: [
      { id: 'direct', kind: 'websocket', label: 'Direct', endpoint: `wss://${id}.example` }
    ]
  }))
  mocks.list.mockImplementation(async () => entries)
  vi.stubGlobal('api', { runtimeEnvironments: { list: mocks.list, reconcile: mocks.reconcile } })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps preparation explicit, preserves its retry ID, and requires a separate activation click', async () => {
  await open()
  await choose('Registration to group with the primary entry', 'right · right')
  expect(mocks.reconcile).not.toHaveBeenCalled()
  mocks.reconcile
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(async () => setStage('prepared'))
  fireEvent.click(button('Verify and prepare'))
  await screen.findByText(/offline/)
  await waitFor(() => expect(button('Verify and prepare').disabled).toBe(false))
  const request = mocks.reconcile.mock.calls[0][0]
  expect(request).toEqual({
    action: 'prepare',
    requestId: expect.any(String),
    environmentIds: ['left', 'right'],
    canonicalEnvironmentId: 'left'
  })
  fireEvent.click(button('Verify and prepare'))
  await screen.findByText('Saved state: prepared, not activated')
  expect(mocks.reconcile.mock.calls[1][0]).toEqual(request)
  expect(mocks.reconcile).toHaveBeenCalledTimes(2)
  await waitFor(() => expect(button('Activate grouping').disabled).toBe(false))
  fireEvent.click(button('Activate grouping'))
  await waitFor(() =>
    expect(mocks.reconcile).toHaveBeenLastCalledWith({
      action: 'activate',
      environmentId: 'left',
      requestId: 'saved-request'
    })
  )
})

it('uses the persisted request to reverse and then cancel an existing group', async () => {
  setStage('catalog-active')
  mocks.reconcile.mockImplementation(async ({ action }) => {
    if (action === 'reverse') {
      setStage('prepared')
    } else {
      entries = entries.map(({ reconciliation: _record, ...entry }) => entry)
    }
  })
  await open()
  expect(screen.queryByRole('button', { name: 'Cancel preparation' })).toBeNull()
  fireEvent.click(button('Reverse grouping'))
  await screen.findByText('Saved state: prepared, not activated')
  await waitFor(() => expect(button('Cancel preparation').disabled).toBe(false))
  fireEvent.click(button('Cancel preparation'))
  await screen.findByLabelText('Registration to group with the primary entry')
  expect(mocks.reconcile.mock.calls.map(([request]) => request)).toEqual([
    { action: 'reverse', environmentId: 'left', requestId: 'saved-request' },
    { action: 'cancel', environmentId: 'left', requestId: 'saved-request' }
  ])
  expect(mocks.hydrate).toHaveBeenLastCalledWith(entries)
})

it('shows a failed-refresh warning and fences saved-state actions until refreshed', async () => {
  setStage('prepared')
  await open()
  mocks.list.mockRejectedValueOnce(new Error('profile read failed'))
  fireEvent.click(button('Activate grouping'))
  await screen.findByText(/Saved state could not be refreshed/)
  expect(button('Activate grouping').disabled).toBe(true)
  expect(button('Cancel preparation').disabled).toBe(true)
  fireEvent.click(button('Refresh'))
  await waitFor(() => expect(button('Activate grouping').disabled).toBe(false))
})

it('does not expose desktop-owned reconciliation in the web client', () => {
  mocks.web.mockReturnValue(true)
  render(<RuntimeEnvironmentReconciliationControl onChanged={vi.fn()} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(mocks.list).not.toHaveBeenCalled()
})
