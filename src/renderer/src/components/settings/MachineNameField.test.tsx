// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

type StoreState = {
  settings: { machineName: string } | null
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: { settings: null, updateSettings: vi.fn() } }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return { holder, useAppStore, getStatus: vi.fn(), updateSettings: vi.fn() }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))

import { MachineNameField } from './MachineNameField'

function renderField(machineName: string, id?: string) {
  mocks.holder.state = { settings: { machineName }, updateSettings: mocks.updateSettings }
  render(<MachineNameField id={id} />)
  return { user: userEvent.setup() }
}

describe('MachineNameField', () => {
  beforeEach(() => {
    mocks.getStatus.mockReset()
    mocks.updateSettings.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { getStatus: mocks.getStatus } }
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
  })

  it('shows the detected name as the blank default and lets the user set an override', async () => {
    mocks.getStatus.mockResolvedValue({ machineName: 'm4airs-Air' })
    const { user } = renderField('')

    expect(await screen.findByPlaceholderText('m4airs-Air')).toBeVisible()
    expect(
      screen.getByText(
        'Other devices and hosts see “m4airs-Air”. Leave this blank to use the computer’s own name.'
      )
    ).toBeVisible()

    await user.type(screen.getByRole('textbox', { name: 'Machine name' }), 'build-server')
    await user.tab()
    expect(mocks.updateSettings).toHaveBeenCalledWith({ machineName: 'build-server' })
  })

  it('captions a saved override without asking the runtime, so a stale read cannot show the old name', async () => {
    // Why: the store only holds a saved value after main has written it, so it already is what
    // devices see. A runtime that still answers with the previous name must not win.
    mocks.getStatus.mockResolvedValue({ machineName: 'Brennan’s MacBook Pro' })
    renderField('QA Override Desk')
    await act(async () => {})

    expect(
      screen.getByText(
        'Other devices and hosts see “QA Override Desk”. Leave this blank to use the computer’s own name.'
      )
    ).toBeVisible()
    expect(mocks.getStatus).not.toHaveBeenCalled()
  })

  it('lets Enter submit an enclosing host form like its sibling inputs, and still commits the name', async () => {
    // Why: the SSH add form mounts this field beside inputs where Enter submits. A name typed just
    // before that submit is committed when the form closes, so it is never lost.
    mocks.getStatus.mockResolvedValue({ machineName: 'm4airs-Air' })
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    mocks.holder.state = { settings: { machineName: '' }, updateSettings: mocks.updateSettings }
    const { unmount } = render(
      <form onSubmit={onSubmit}>
        <MachineNameField id="ssh-target-machine-name" />
        <button type="submit">Save</button>
      </form>
    )
    const user = userEvent.setup()

    await user.type(screen.getByRole('textbox', { name: 'Machine name' }), 'build-server{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(mocks.updateSettings).not.toHaveBeenCalled()

    unmount()
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({ machineName: 'build-server' })
  })

  it('keys the input, label, and caption off the mount id so two surfaces never collide', async () => {
    mocks.getStatus.mockResolvedValue({ machineName: 'm4airs-Air' })
    renderField('', 'ssh-target-machine-name')
    await act(async () => {})

    const input = screen.getByRole('textbox', { name: 'Machine name' })
    expect(input).toHaveAttribute('id', 'ssh-target-machine-name')
    expect(input).toHaveAccessibleDescription(
      'Other devices and hosts see “m4airs-Air”. Leave this blank to use the computer’s own name.'
    )
  })

  it('places a host class on its own root so a grid slot disappears with it', async () => {
    mocks.getStatus.mockResolvedValue({ machineName: 'm4airs-Air' })
    mocks.holder.state = { settings: { machineName: '' }, updateSettings: mocks.updateSettings }
    const { container } = render(<MachineNameField className="mp-pairing-machine" />)
    await act(async () => {})

    expect(container.firstElementChild).toHaveClass('mp-pairing-machine', 'space-y-2')
  })

  it('renders nothing in the web client, which has no machine of its own to name', async () => {
    Object.defineProperty(window, '__ORCA_WEB_CLIENT__', { configurable: true, value: true })
    mocks.getStatus.mockResolvedValue({ machineName: 'remote-host' })
    mocks.holder.state = { settings: { machineName: '' }, updateSettings: mocks.updateSettings }
    const { container } = render(<MachineNameField />)
    await act(async () => {})

    expect(container).toBeEmptyDOMElement()
  })
})
