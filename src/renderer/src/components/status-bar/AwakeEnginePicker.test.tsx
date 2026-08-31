// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ComputerAwakeStatus, MacosAwakeEngine } from '../../../../shared/computer-awake-mode'
import { AwakeEnginePicker } from './AwakeEnginePicker'

const mocks = vi.hoisted(() => ({
  openListing: vi.fn<() => Promise<void>>(),
  refreshInstallation: vi.fn<() => Promise<boolean | undefined>>()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/amphetamine-installation', () => ({
  openAmphetamineListing: mocks.openListing,
  refreshAmphetamineInstallation: mocks.refreshInstallation
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({
    children,
    value,
    ...props
  }: {
    children: ReactNode
    value: string
    'aria-label'?: string
  }) => (
    <div role="radiogroup" data-value={value} {...props}>
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    disabled,
    onSelect,
    value,
    ...props
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
    value: string
    'aria-label'?: string
  }) => (
    <button
      type="button"
      role="radio"
      disabled={disabled}
      data-value={value}
      onClick={() => onSelect?.({ preventDefault: () => {} })}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: () => {} })}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

type ChangeMock = Mock<(engine: MacosAwakeEngine) => void>

function renderPicker({
  engine = 'caffeinate',
  status = {},
  onChange = vi.fn<(engine: MacosAwakeEngine) => void>()
}: {
  engine?: MacosAwakeEngine
  status?: Partial<ComputerAwakeStatus>
  onChange?: ChangeMock
} = {}): ChangeMock {
  render(
    <AwakeEnginePicker
      engine={engine}
      status={{ mode: 'auto', active: false, ...status }}
      onChange={onChange}
    />
  )
  return onChange
}

describe('AwakeEnginePicker', () => {
  beforeEach(() => {
    mocks.openListing.mockReset().mockResolvedValue(undefined)
    mocks.refreshInstallation.mockReset().mockResolvedValue(false)
  })

  afterEach(cleanup)

  it('selects the installed integration without a warning flow', async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ status: { amphetamineInstalled: true } })

    await user.click(screen.getByRole('radio', { name: 'Amphetamine (read-only)' }))

    expect(onChange).toHaveBeenCalledWith('amphetamine')
  })

  it('keeps an unknown installation inert and exposes a retry', async () => {
    const user = userEvent.setup()
    const onChange = renderPicker()
    const amphetamine = screen.getByRole('radio', { name: 'Amphetamine (read-only)' })

    expect(amphetamine).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Get Amphetamine…' })).not.toBeInTheDocument()
    await user.click(amphetamine)
    expect(onChange).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(mocks.refreshInstallation).toHaveBeenCalledOnce()
  })

  it('separates the disabled integration choice from the keyboard-reachable install action', async () => {
    const user = userEvent.setup()
    const onChange = renderPicker({ status: { amphetamineInstalled: false } })

    expect(screen.getByRole('radio', { name: 'Amphetamine (read-only)' })).toBeDisabled()
    const getAction = screen.getByRole('button', { name: 'Get Amphetamine…' })
    expect(getAction).toBeEnabled()

    await user.click(getAction)

    expect(mocks.openListing).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('leaves a denied integration retry to the main process', async () => {
    const user = userEvent.setup()
    mocks.refreshInstallation.mockResolvedValue(true)
    const onChange = renderPicker({
      engine: 'amphetamine',
      status: {
        amphetamineInstalled: true,
        amphetamineUnavailableReason: 'automation-denied'
      }
    })

    await user.click(screen.getByRole('button', { name: 'Check again' }))

    expect(mocks.refreshInstallation).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not re-pick after a missing installation probe succeeds', async () => {
    const user = userEvent.setup()
    mocks.refreshInstallation.mockResolvedValue(true)
    const onChange = renderPicker({
      engine: 'amphetamine',
      status: { amphetamineInstalled: false }
    })

    await user.click(screen.getByRole('button', { name: 'Check again' }))

    expect(mocks.refreshInstallation).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not undo Built-in only when an Automation check finishes late', async () => {
    const user = userEvent.setup()
    let resolveCheck!: (installed: boolean | undefined) => void
    const pendingCheck = new Promise<boolean | undefined>((resolve) => {
      resolveCheck = resolve
    })
    mocks.refreshInstallation.mockReturnValue(pendingCheck)
    const onChange = renderPicker({
      engine: 'amphetamine',
      status: {
        amphetamineInstalled: true,
        amphetamineUnavailableReason: 'automation-denied'
      }
    })

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    await user.click(screen.getByRole('radio', { name: 'Built-in only' }))
    await act(async () => {
      resolveCheck(true)
      await pendingCheck
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('caffeinate')
  })

  it('reports an indeterminate probe as a check failure', async () => {
    const user = userEvent.setup()
    mocks.refreshInstallation.mockResolvedValue(undefined)
    renderPicker({ status: { amphetamineInstalled: false } })

    await user.click(screen.getByRole('button', { name: 'Check again' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t check for Amphetamine. Try again.'
    )
  })

  it('reports an App Store open failure accurately', async () => {
    const user = userEvent.setup()
    mocks.openListing.mockRejectedValue(new Error('open failed'))
    renderPicker({ status: { amphetamineInstalled: false } })

    await user.click(screen.getByRole('button', { name: 'Get Amphetamine…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t open the Amphetamine listing. Try again.'
    )
  })

  it('shows the Automation recovery guidance visibly', () => {
    renderPicker({
      engine: 'amphetamine',
      status: {
        amphetamineInstalled: true,
        amphetamineUnavailableReason: 'automation-denied'
      }
    })

    expect(screen.getByText(/Privacy & Security › Automation/)).toBeInTheDocument()
    expect(screen.getByText(/only observes Amphetamine session activity/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('describes the read-only integration without tooltips or lid guarantees', () => {
    renderPicker({ status: { amphetamineInstalled: true } })

    expect(screen.getByText('When keep-awake is active, Orca uses Caffeinate.')).toBeInTheDocument()
    expect(
      screen.getByText(/Orca still uses Caffeinate; this only observes a session/)
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Works with the lid shut')
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  })
})
