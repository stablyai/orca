// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { BotComputerPicker } from './BotComputerPicker'
import type { BotCreateHost, BotCreateHostChoice } from './bot-create-hosts'

afterEach(cleanup)

const local: BotCreateHost = { hostId: LOCAL_EXECUTION_HOST_ID, label: 'Local Mac' }
// A paired server on an older Orca: listing it asks whether it can be updated.
const older: BotCreateHost = {
  hostId: 'runtime:lab',
  label: 'lab-pc',
  environmentId: 'lab',
  blocked: 'no-bots'
}

describe('BotComputerPicker', () => {
  it('reads the other computers only once the list opens', () => {
    const refreshRemoteServerUpdates = vi.fn(async () => {})
    useAppStore.setState({ remoteServerUpdates: new Map(), refreshRemoteServerUpdates })
    const setListing = vi.fn()
    const choice: BotCreateHostChoice = {
      hosts: [local, older],
      host: local,
      setHostId: () => {},
      otherAccount: null,
      otherAccountOf: () => null,
      setListing,
      reset: () => {}
    }
    render(
      <TooltipProvider>
        <BotComputerPicker hostChoice={choice} />
      </TooltipProvider>
    )

    expect(setListing).not.toHaveBeenCalledWith(true)
    expect(refreshRemoteServerUpdates).not.toHaveBeenCalled()

    fireEvent.focus(screen.getByRole('combobox', { name: 'Computer' }))
    expect(setListing).toHaveBeenLastCalledWith(true)
    expect(refreshRemoteServerUpdates).toHaveBeenCalledTimes(1)
  })
})
