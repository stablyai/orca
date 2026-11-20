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
const ready: BotCreateHost = { hostId: 'runtime:gpu', label: 'gpu-box', environmentId: 'gpu' }

function choiceOf(
  hosts: BotCreateHost[],
  host: BotCreateHost,
  rest: Partial<BotCreateHostChoice> = {}
): BotCreateHostChoice {
  return {
    hosts,
    host,
    setHostId: () => {},
    otherAccount: null,
    otherAccountOf: () => null,
    setListing: () => {},
    reset: () => {},
    ...rest
  }
}

function renderPicker(choice: BotCreateHostChoice): HTMLElement {
  render(
    <TooltipProvider>
      <BotComputerPicker hostChoice={choice} onAddHost={() => {}} />
    </TooltipProvider>
  )
  return screen.getByRole('combobox', { name: 'Computer' })
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

  it('asks no server about updates while closed, even for an older one that is picked', () => {
    const refreshRemoteServerUpdates = vi.fn(async () => {})
    useAppStore.setState({ remoteServerUpdates: new Map(), refreshRemoteServerUpdates })
    renderPicker(choiceOf([local, older], older))

    expect(refreshRemoteServerUpdates).not.toHaveBeenCalled()
  })

  it('picks the next computer, not Add host, when a key reopens the list', () => {
    useAppStore.setState({
      remoteServerUpdates: new Map(),
      refreshRemoteServerUpdates: async () => {}
    })
    const setHostId = vi.fn()
    const field = renderPicker(choiceOf([local, ready], local, { setHostId }))
    fireEvent.focus(field)
    fireEvent.keyDown(field, { key: 'Escape' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(setHostId).toHaveBeenCalledWith('runtime:gpu')
    expect(screen.queryByText('Add SSH host')).toBeNull()
  })

  it('tells assistive tech the picked computer, not the row being browsed', () => {
    useAppStore.setState({
      remoteServerUpdates: new Map(),
      refreshRemoteServerUpdates: async () => {}
    })
    const field = renderPicker(choiceOf([local, ready], ready))
    const described = (): string | null | undefined =>
      document.getElementById(field.getAttribute('aria-describedby') ?? '')?.textContent
    expect(described()).toBe('gpu-box')

    fireEvent.focus(field)
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowUp' })
    expect(described()).toBe('gpu-box')
  })
})
