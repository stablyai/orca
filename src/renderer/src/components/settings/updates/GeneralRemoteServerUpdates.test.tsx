// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import type { RemoteServerUpdatesSlice } from '@/store/slices/runtime-host-updates/remote-server-updates'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'

function server(
  environmentId: string,
  name: string,
  phase: RemoteServerUpdateEntry['phase'],
  extra: Partial<RemoteServerUpdateEntry> = {}
): RemoteServerUpdateEntry {
  return {
    environmentId,
    name,
    phase,
    currentVersion: '1.4.270',
    targetVersion: '1.4.281',
    progress: null,
    runtimeId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    support: null,
    error: null,
    ...extra
  }
}

const start = vi.fn<RemoteServerUpdatesSlice['startRemoteServerUpdates']>(async () => {})

function seed(entries: RemoteServerUpdateEntry[], running = false): void {
  useAppStore.setState({
    remoteServerUpdates: new Map(entries.map((entry) => [entry.environmentId, entry])),
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: running,
    remoteServerUpdatesCheckRevision: 0,
    refreshRemoteServerUpdates: async () => ({ revision: 0 }),
    startRemoteServerUpdates: start
  })
}

beforeEach(() => {
  start.mockClear()
  seed([server('env-1', 'build-box', 'available'), server('env-2', 'gpu-west', 'available')])
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

function renderServers(): void {
  render(
    <TooltipProvider>
      <GeneralRemoteServerUpdates />
      <button type="button">Elsewhere</button>
    </TooltipProvider>
  )
}

/** Settles the fresh check that opening the list starts. */
async function settle(): Promise<void> {
  await act(async () => {})
}

async function armUpdateAll(): Promise<HTMLElement> {
  const button = screen.getByRole('button', { name: 'Update all' })
  button.focus()
  fireEvent.click(button)
  await settle()
  return button
}

it('arms Update all in place instead of restarting, and names the whole question', async () => {
  renderServers()
  const button = await armUpdateAll()

  expect(start).not.toHaveBeenCalled()
  expect(button.textContent).toBe('Restart 2?')
  expect(screen.getByRole('button', { name: 'Restart 2 servers? Live sessions may drop.' })).toBe(
    button
  )
  expect(screen.getByText('Sessions may drop')).toBeTruthy()
  expect(document.activeElement).toBe(button)
  // No floating confirmation layer.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
})

it('starts exactly the named servers on the second click', async () => {
  renderServers()
  const button = await armUpdateAll()
  fireEvent.click(button)

  expect(start).toHaveBeenCalledTimes(1)
  expect(start.mock.calls[0][0]).toEqual(['env-1', 'env-2'])
})

it('reverts on Esc without restarting', async () => {
  renderServers()
  const button = await armUpdateAll()
  fireEvent.keyDown(button, { key: 'Escape' })

  expect(button.textContent).toBe('Update all')
  expect(screen.queryByText('Sessions may drop')).toBeNull()
  expect(document.activeElement).toBe(button)
  fireEvent.click(button)
  expect(start).not.toHaveBeenCalled()
})

it('reverts on a click anywhere else', async () => {
  renderServers()
  const button = await armUpdateAll()
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))

  expect(button.textContent).toBe('Update all')
  expect(start).not.toHaveBeenCalled()
})

it('does not treat a double-click or a held Enter as the confirmation', async () => {
  renderServers()
  const button = await armUpdateAll()
  fireEvent.click(button, { detail: 2 })
  fireEvent.keyDown(button, { key: 'Enter', repeat: true })

  expect(start).not.toHaveBeenCalled()
  expect(button.textContent).toBe('Restart 2?')
})

it("arms one server's row as Restart? and updates only that server", async () => {
  renderServers()
  fireEvent.click(screen.getByRole('button', { name: /^Servers/ }))
  await settle()
  const [row] = screen.getAllByRole('button', { name: 'Update' })
  row.focus()
  fireEvent.click(row)

  expect(row.textContent).toBe('Restart?')
  expect(screen.getByRole('button', { name: 'Restart build-box? Live sessions may drop.' })).toBe(
    row
  )
  expect(start).not.toHaveBeenCalled()

  fireEvent.click(row)
  expect(start.mock.calls[0][0]).toEqual(['env-1'])
})

it("shows each server's own update state while updates run", async () => {
  seed(
    [
      server('env-1', 'build-box', 'downloading', { progress: 42 }),
      server('env-2', 'gpu-west', 'restarting'),
      server('env-3', 'edge-01', 'updated', { currentVersion: '1.4.281' }),
      server('env-4', 'lab-runner', 'failed', { error: 'Did not reconnect.' })
    ],
    true
  )
  renderServers()
  expect(screen.getByText('1 failed').parentElement?.textContent).toBe('2 updating · 1 failed')
  // The header has no control while rows carry the progress.
  expect(screen.queryByRole('button', { name: 'Update all' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /^Servers/ }))
  await settle()
  expect(screen.getByText('42%')).toBeTruthy()
  expect(screen.getByRole('progressbar', { name: 'build-box' }).getAttribute('aria-valuenow')).toBe(
    '42'
  )
  expect(screen.getByText('Restarting…')).toBeTruthy()
  // Wide and narrow copies of the version share the row; CSS shows one.
  expect(screen.getAllByText('v1.4.281').length).toBeGreaterThan(0)
  expect(screen.getByText('Failed')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(true)
})
