// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MachineLeftoverCheck from './MachineLeftoverCheck'

const machines = { list: vi.fn(), delete: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', Object.assign(window, { api: { machines } }))
})
afterEach(cleanup)

function renderCheck(knownMachine: { id: string; name: string } | null = null): void {
  render(
    <MachineLeftoverCheck
      providerKey="plugin:o/omarchy"
      providerName="Omarchy"
      operationId="op-1"
      knownMachine={knownMachine}
      onDeleted={vi.fn()}
    />
  )
}

const listed = (machinesList: unknown[], pendingCreates: unknown[] = []) => ({
  ok: true,
  value: { machines: machinesList, pendingCreates }
})

describe('MachineLeftoverCheck', () => {
  it('never reports none when the provider could not be listed', async () => {
    machines.list.mockResolvedValue({ ok: false, code: 'timeout', message: 'ssh timed out' })
    renderCheck()
    fireEvent.click(screen.getByRole('button', { name: 'Check for a leftover machine' }))
    expect(await screen.findByText('Couldn’t reach Omarchy to check.')).toBeTruthy()
    expect(screen.queryByText('No leftover machine')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('waits for the provider to settle before saying none', async () => {
    machines.list.mockResolvedValueOnce(listed([], [{ operationId: 'op-1' }]))
    renderCheck()
    fireEvent.click(screen.getByRole('button', { name: 'Check for a leftover machine' }))
    expect(await screen.findByText('Nothing found yet.')).toBeTruthy()

    machines.list.mockResolvedValueOnce(listed([]))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByText('No leftover machine')).toBeTruthy()
  })

  it('offers Delete for a found machine and says when deleting failed', async () => {
    machines.list.mockResolvedValue(
      listed([{ id: 'm-1', name: 'box', state: 'running', creatingOperationId: 'op-1' }])
    )
    machines.delete.mockResolvedValue({ ok: false, code: 'unavailable', message: 'boom' })
    renderCheck()
    fireEvent.click(screen.getByRole('button', { name: 'Check for a leftover machine' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete box' }))
    await waitFor(() =>
      expect(screen.getByText('Couldn’t delete it. The provider ran into a problem.')).toBeTruthy()
    )
  })

  it('keeps offering Delete when the provider still lists the machine afterwards', async () => {
    machines.list.mockResolvedValue(
      listed([{ id: 'm-1', name: 'box', state: 'running', creatingOperationId: 'op-1' }])
    )
    machines.delete.mockResolvedValue({ ok: true, value: { id: 'm-1', state: 'error' } })
    renderCheck()
    fireEvent.click(screen.getByRole('button', { name: 'Check for a leftover machine' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete box' }))
    await waitFor(() => expect(screen.getByText(/The provider still lists it/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Delete box' })).toBeTruthy()
  })

  it('offers Delete at once for a machine the create already reported', () => {
    renderCheck({ id: 'm-1', name: 'box' })
    expect(screen.getByRole('button', { name: 'Delete box' })).toBeTruthy()
    expect(machines.list).not.toHaveBeenCalled()
  })
})
