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

function seed(entries: RemoteServerUpdateEntry[]): void {
  useAppStore.setState({
    remoteServerUpdates: new Map(entries.map((entry) => [entry.environmentId, entry])),
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    remoteServerUpdatesCheckRevision: 0,
    refreshRemoteServerUpdates: async () => ({ revision: 0 }),
    startRemoteServerUpdates: start
  })
}

beforeEach(() => {
  start.mockClear()
  seed([
    server('env-1', 'build-box', 'available'),
    server('env-2', 'gpu-west', 'available'),
    server('env-3', 'lab-runner', 'failed', { error: 'Did not reconnect.' })
  ])
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

// Updating restarts servers and can drop live sessions, so a restart must take a deliberate second
// action on the same control, and must restart exactly the servers that control named.
it('restarts servers only on a deliberate second action, and only the servers it named', async () => {
  renderServers()
  const updateAll = screen.getByRole('button', { name: 'Update all' })
  updateAll.focus()

  // Each way of arming and then backing out leaves every server untouched.
  const backOuts: (() => void)[] = [
    () => fireEvent.keyDown(updateAll, { key: 'Escape' }),
    () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' })),
    () => fireEvent.blur(updateAll),
    // The second click of a double-click, and a held Enter, are not confirmations.
    () => {
      fireEvent.click(updateAll, { detail: 2 })
      fireEvent.keyDown(updateAll, { key: 'Enter', repeat: true })
      fireEvent.keyDown(updateAll, { key: 'Escape' })
    }
  ]
  for (const backOut of backOuts) {
    fireEvent.click(updateAll)
    await settle()
    backOut()
    // A click after backing out arms again; it never restarts.
    expect(start).not.toHaveBeenCalled()
  }

  fireEvent.click(updateAll)
  await settle()
  fireEvent.click(updateAll)
  expect(start).toHaveBeenCalledTimes(1)
  expect(start.mock.calls[0][0]).toEqual(['env-1', 'env-2', 'env-3'])

  // One server's own action restarts that server alone.
  start.mockClear()
  cleanup()
  renderServers()
  fireEvent.click(screen.getByRole('button', { name: /^Servers/ }))
  await settle()
  const retry = screen.getByRole('button', { name: 'Retry lab-runner' })
  retry.focus()
  fireEvent.click(retry)
  expect(start).not.toHaveBeenCalled()
  fireEvent.click(retry)
  expect(start.mock.calls).toEqual([[['env-3'], { revision: 0 }]])
})
