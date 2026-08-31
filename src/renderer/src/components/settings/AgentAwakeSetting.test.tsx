// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ComputerAwakeStatus } from '../../../../shared/computer-awake-mode'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AgentAwakeSetting } from './AgentAwakeSetting'

const mocks = vi.hoisted(() => ({
  platform: 'darwin' as NodeJS.Platform,
  openListing: vi.fn<() => Promise<void>>(),
  refreshInstallation: vi.fn<() => Promise<boolean | undefined>>()
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => mocks.platform
}))

vi.mock('@/lib/amphetamine-installation', () => ({
  openAmphetamineListing: mocks.openListing,
  refreshAmphetamineInstallation: mocks.refreshInstallation
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => children
}))

type UpdateSettingsMock = Mock<(updates: Partial<GlobalSettings>) => void>

function renderSetting({
  awakeStatus,
  engine = 'caffeinate',
  updateSettings = vi.fn<(updates: Partial<GlobalSettings>) => void>()
}: {
  awakeStatus?: ComputerAwakeStatus
  engine?: 'caffeinate' | 'amphetamine'
  updateSettings?: UpdateSettingsMock
} = {}): UpdateSettingsMock {
  render(
    <AgentAwakeSetting
      settings={{ ...getDefaultSettings('/tmp'), computerAwakeMacosEngine: engine }}
      updateSettings={updateSettings}
      awakeStatus={awakeStatus}
    />
  )
  return updateSettings
}

describe('AgentAwakeSetting Amphetamine integration', () => {
  beforeEach(() => {
    mocks.platform = 'darwin'
    mocks.openListing.mockReset().mockResolvedValue(undefined)
    mocks.refreshInstallation.mockReset().mockResolvedValue(false)
  })

  afterEach(cleanup)

  it('shows the integration on macOS and defaults to Built-in only', () => {
    renderSetting()

    expect(screen.getByText('Amphetamine integration')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Built-in only' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Amphetamine (read-only)' })).not.toBeChecked()
    expect(screen.getByText(/When keep-awake is active, Orca uses Caffeinate/)).toBeInTheDocument()
  })

  it('hides the integration off macOS', () => {
    mocks.platform = 'linux'
    renderSetting()

    expect(screen.queryByText('Amphetamine integration')).not.toBeInTheDocument()
  })

  it('persists the installed Amphetamine choice immediately', async () => {
    const user = userEvent.setup()
    const updateSettings = renderSetting({
      awakeStatus: {
        mode: 'auto',
        active: false,
        amphetamineInstalled: true
      }
    })

    await user.click(screen.getByRole('radio', { name: 'Amphetamine (read-only)' }))

    expect(updateSettings).toHaveBeenCalledWith({ computerAwakeMacosEngine: 'amphetamine' })
  })

  it('keeps an unknown installation inert and exposes a retry', async () => {
    const user = userEvent.setup()
    const updateSettings = renderSetting()
    const amphetamine = screen.getByRole('radio', { name: 'Amphetamine (read-only)' })

    expect(amphetamine).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('button', { name: 'Get Amphetamine…' })).not.toBeInTheDocument()
    await user.click(amphetamine)
    expect(updateSettings).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(mocks.refreshInstallation).toHaveBeenCalledOnce()
  })

  it('stacks the integration control at narrow window widths', () => {
    renderSetting({ awakeStatus: { mode: 'auto', active: false, amphetamineInstalled: true } })

    expect(
      screen.getByRole('radiogroup', { name: 'Amphetamine integration' }).parentElement
    ).toHaveClass('flex-col', 'sm:flex-row')
  })

  it('keeps an unavailable choice inert and exposes separate install and retry actions', async () => {
    const user = userEvent.setup()
    const updateSettings = renderSetting({
      awakeStatus: {
        mode: 'auto',
        active: false,
        amphetamineInstalled: false
      }
    })
    const amphetamine = screen.getByRole('radio', { name: 'Amphetamine (read-only)' })

    expect(amphetamine).toHaveAttribute('aria-disabled', 'true')
    await user.click(amphetamine)
    expect(updateSettings).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Get Amphetamine…' }))
    expect(mocks.openListing).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(mocks.refreshInstallation).toHaveBeenCalledOnce()
  })

  it('leaves a successful Automation retry to the main process', async () => {
    const user = userEvent.setup()
    mocks.refreshInstallation.mockResolvedValue(true)
    const updateSettings = renderSetting({
      engine: 'amphetamine',
      awakeStatus: {
        mode: 'auto',
        active: false,
        amphetamineInstalled: true,
        amphetamineUnavailableReason: 'automation-denied'
      }
    })

    await user.click(screen.getByRole('button', { name: 'Check again' }))

    expect(mocks.refreshInstallation).toHaveBeenCalledOnce()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('does not undo a Built-in only choice made during an Automation check', async () => {
    const user = userEvent.setup()
    let resolveCheck!: (installed: boolean | undefined) => void
    const pendingCheck = new Promise<boolean | undefined>((resolve) => {
      resolveCheck = resolve
    })
    mocks.refreshInstallation.mockReturnValue(pendingCheck)
    const updateSettings = renderSetting({
      engine: 'amphetamine',
      awakeStatus: {
        mode: 'auto',
        active: false,
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

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenCalledWith({ computerAwakeMacosEngine: 'caffeinate' })
  })

  it('reports an indeterminate probe as a check failure', async () => {
    const user = userEvent.setup()
    mocks.refreshInstallation.mockResolvedValue(undefined)
    renderSetting({
      awakeStatus: { mode: 'auto', active: false, amphetamineInstalled: false }
    })

    await user.click(screen.getByRole('button', { name: 'Check again' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t check for Amphetamine. Try again.'
    )
  })

  it('reports an App Store open failure accurately', async () => {
    const user = userEvent.setup()
    mocks.openListing.mockRejectedValue(new Error('open failed'))
    renderSetting({
      awakeStatus: { mode: 'auto', active: false, amphetamineInstalled: false }
    })

    await user.click(screen.getByRole('button', { name: 'Get Amphetamine…' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t open the Amphetamine listing. Try again.'
    )
  })

  it('shows Automation guidance and a visible retry', () => {
    renderSetting({
      engine: 'amphetamine',
      awakeStatus: {
        mode: 'auto',
        active: false,
        amphetamineInstalled: true,
        amphetamineUnavailableReason: 'automation-denied'
      }
    })

    expect(screen.getByText(/Privacy & Security › Automation/)).toBeInTheDocument()
    expect(screen.getByText(/only observes Amphetamine session activity/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('does not promise unconditional closed-lid behavior or use tooltips', () => {
    renderSetting({
      awakeStatus: { mode: 'auto', active: false, amphetamineInstalled: true }
    })

    expect(document.body).not.toHaveTextContent('Works with the lid shut')
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  })
})
