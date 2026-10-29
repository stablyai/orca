// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeShareComputerButton } from './runtime-share-computer-button'

vi.mock('./RuntimePairingUrlGenerator', () => ({ RuntimePairingUrlGenerator: () => null }))
vi.mock('./MachineNameField', () => ({ MachineNameField: () => <div>machine-name-field</div> }))
vi.mock('./use-published-machine-name', () => ({ usePublishedMachineName: () => 'Studio' }))

const listRuntimeAccessGrants = vi.fn(async () => ({ grants: [{ deviceId: 'a' }] }))

beforeEach(() => {
  listRuntimeAccessGrants.mockClear()
  Object.assign(window, { api: { ...window.api, mobile: { listRuntimeAccessGrants } } })
})
afterEach(cleanup)

it('closes through Done like any other dismissal', async () => {
  render(<RuntimeShareComputerButton />)
  fireEvent.click(screen.getByRole('button', { name: 'Share this computer' }))
  await waitFor(() => expect(screen.queryByText('1 active link')).not.toBeNull())
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.queryByText('machine-name-field')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(listRuntimeAccessGrants).toHaveBeenCalledTimes(2))

  fireEvent.click(screen.getByRole('button', { name: 'Share this computer' }))
  expect(await screen.findByRole('button', { name: 'Edit' })).not.toBeNull()
  expect(screen.queryByText('machine-name-field')).toBeNull()
})
