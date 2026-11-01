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

  it('captions a saved override without asking the runtime, so a stale read cannot show the old name', async () => {
    // Saved store names are already persisted; a stale runtime read must not override what peers see.
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
    // Enter submits the enclosing SSH form; commit on closure so a just-typed name survives.
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
})
