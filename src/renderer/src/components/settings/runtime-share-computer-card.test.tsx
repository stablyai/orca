// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RuntimeShareComputerCard } from './runtime-share-computer-card'

vi.mock('./RuntimePairingUrlGenerator', () => ({ RuntimePairingUrlGenerator: () => null }))
vi.mock('./MachineNameField', () => ({ MachineNameField: () => <div>machine-name-field</div> }))
vi.mock('./use-published-machine-name', () => ({ usePublishedMachineName: () => 'Studio' }))

const listRuntimeAccessGrants = vi.fn(async () => ({ grants: [{ deviceId: 'a' }] }))

beforeEach(() => {
  listRuntimeAccessGrants.mockClear()
  Object.assign(window, { api: { ...window.api, mobile: { listRuntimeAccessGrants } } })
})
afterEach(cleanup)

// Done and Esc must close the same way: reset the name editor and recount links.
it('closes through Done like any other dismissal', async () => {
  render(<RuntimeShareComputerCard />)
  await waitFor(() => expect(screen.queryByText('1 active link')).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: /Share…/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  expect(screen.queryByText('machine-name-field')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  await waitFor(() => expect(listRuntimeAccessGrants).toHaveBeenCalledTimes(2))

  fireEvent.click(screen.getByRole('button', { name: /Share…/ }))
  expect(await screen.findByRole('button', { name: 'Edit' })).not.toBeNull()
  expect(screen.queryByText('machine-name-field')).toBeNull()
})
