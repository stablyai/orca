// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { RemoteServerUpdateEntry } from '@/runtime/hosts/updates/remote-server-update-coordinator'
import type { RemoteServerUpdateCheck } from '@/store/slices/runtime-host-updates/remote-server-updates'
import { RemoteServerUpdateDialog } from './RemoteServerUpdateDialog'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const server: RemoteServerUpdateEntry = {
  environmentId: 'env-1',
  name: 'build-box',
  phase: 'available',
  currentVersion: '1.4.270',
  targetVersion: '1.4.281',
  progress: null,
  runtimeId: null,
  liveTabCount: 1,
  liveLeafCount: 1,
  support: null,
  error: null
}

// A confirmation may only act on targets and live-session counts checked for the current opening:
// a check that settles after the dialog was closed and reopened belongs to the earlier opening.
it('ignores a check from an earlier opening after a close and reopen', async () => {
  const pending: ((check: RemoteServerUpdateCheck) => void)[] = []
  useAppStore.setState({
    remoteServerUpdates: new Map([[server.environmentId, server]]),
    remoteServerUpdatesCheckRevision: 0,
    remoteServerUpdateDialogOpen: true,
    refreshRemoteServerUpdates: () =>
      new Promise<RemoteServerUpdateCheck | undefined>((resolve) => pending.push(resolve))
  })
  render(
    <TooltipProvider>
      <RemoteServerUpdateDialog />
    </TooltipProvider>
  )
  expect(pending).toHaveLength(1)

  // Close and reopen in one batch while the first refresh is still in flight.
  act(() => {
    useAppStore.getState().setRemoteServerUpdateDialogOpen(false)
    useAppStore.getState().setRemoteServerUpdateDialogOpen(true)
  })
  expect(pending).toHaveLength(2)

  await act(async () => pending[0]({ revision: 0 }))
  const update = screen.getByRole('button', { name: 'Update server' })
  expect(update.hasAttribute('disabled')).toBe(true)

  await act(async () => pending[1]({ revision: 0 }))
  expect(update.hasAttribute('disabled')).toBe(false)
})
