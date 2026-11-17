// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { WslHostAddProgress } from '../../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { AddWslHostDialogBody } from './AddWslHostDialogBody'

let progress: ((update: WslHostAddProgress) => void) | null = null

function Harness(): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  return (
    <Dialog open>
      <DialogContent>
        <AddWslHostDialogBody
          adding={adding}
          onAddingChange={setAdding}
          onAdded={() => {}}
          onCancel={() => {}}
        />
      </DialogContent>
    </Dialog>
  )
}

describe('AddWslHostDialogBody', () => {
  beforeEach(() => {
    Object.assign(window, {
      api: {
        runtimeEnvironments: {
          wslHosts: {
            listDistros: vi.fn(async () => [
              { name: 'Ubuntu', state: 'running', version: 2, environmentId: null }
            ]),
            // Never settles: the Add stays in flight while main reports what it waits for.
            add: vi.fn(() => new Promise(() => {})),
            onAddProgress: vi.fn((callback: (update: WslHostAddProgress) => void) => {
              progress = callback
              return () => (progress = null)
            })
          }
        }
      }
    })
  })
  afterEach(() => {
    cleanup()
    progress = null
  })

  it('names the install lock an Add waits on instead of the generic setup hint', async () => {
    render(<Harness />)
    const add = await screen.findByRole('button', { name: 'Add host' })
    await waitFor(() => expect(add.hasAttribute('disabled')).toBe(false))
    fireEvent.click(add)
    await waitFor(() => expect(progress).not.toBeNull())
    expect(screen.getByText(/Installing and starting the Orca server/)).toBeTruthy()

    const waiting =
      'Waiting for another Orca install in this distro to finish. If it doesn’t, Orca stops waiting in about 2 minutes.'
    act(() =>
      progress?.({
        distro: 'Ubuntu',
        detail: waiting,
        detailCode: 'installLockWaitGivesUp',
        detailParams: { count: 2 }
      })
    )
    expect(screen.getByText(waiting)).toBeTruthy()
    expect(screen.queryByText(/Installing and starting the Orca server/)).toBeNull()

    // Once the lock is taken, the setup hint returns.
    act(() => progress?.({ distro: 'Ubuntu', detail: null }))
    expect(screen.queryByText(waiting)).toBeNull()
    expect(screen.getByText(/Installing and starting the Orca server/)).toBeTruthy()
  })

  // Another window's Add broadcasts to every window; it must not touch this dialog's wait.
  it('ignores another distro’s Add progress and matches its own case-insensitively', async () => {
    const hosts = window.api.runtimeEnvironments?.wslHosts
    vi.mocked(hosts!.listDistros).mockResolvedValue([
      { name: 'Ubuntu', state: 'running', version: 2, environmentId: null },
      { name: 'Debian', state: 'running', version: 2, environmentId: 'wsl:debian' }
    ])
    render(<Harness />)
    const add = await screen.findByRole('button', { name: 'Add host' })
    await waitFor(() => expect(add.hasAttribute('disabled')).toBe(false))
    fireEvent.click(add)
    await waitFor(() => expect(progress).not.toBeNull())

    const ubuntuWait =
      'Waiting for another Orca install in this distro to finish. If it doesn’t, Orca takes over in about 5 minutes.'
    act(() =>
      progress?.({
        distro: 'ubuntu',
        detail: ubuntuWait,
        detailCode: 'installLockWait',
        detailParams: { count: 5 }
      })
    )
    expect(screen.getByText(ubuntuWait)).toBeTruthy()

    act(() =>
      progress?.({
        distro: 'Debian',
        detail:
          'Waiting for another Orca install in this distro to finish. If it doesn’t, Orca takes over in about 1 minute.',
        detailCode: 'installLockWait',
        detailParams: { count: 1 }
      })
    )
    act(() => progress?.({ distro: 'Debian', detail: null }))
    expect(screen.getByText(ubuntuWait)).toBeTruthy()
    expect(screen.queryByText(/about 1 minute\./)).toBeNull()
  })
})
