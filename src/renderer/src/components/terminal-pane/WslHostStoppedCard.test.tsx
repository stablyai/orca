// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WslHostStoppedCard } from './WslHostStoppedCard'

const { connectWslHost, reloadProjects, toastError } = vi.hoisted(() => ({
  connectWslHost: vi.fn(),
  reloadProjects: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? ''),
  getIntlLocale: () => 'en-US'
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: reloadProjects
}))
function renderStoppedPane(onStarted = vi.fn()) {
  render(<WslHostStoppedCard environmentId="env-1" distro="Ubuntu" onStarted={onStarted} />)
  return onStarted
}

beforeEach(() => {
  connectWslHost.mockReset().mockResolvedValue(undefined)
  reloadProjects.mockReset().mockResolvedValue(true)
  toastError.mockReset()
  Object.assign(window, { api: { runtimeEnvironments: { wslHosts: { connect: connectWslHost } } } })
})

afterEach(() => {
  cleanup()
})

describe('a terminal on a stopped WSL distro', () => {
  it('says the distro is stopped and offers Start, never "retrying automatically"', () => {
    renderStoppedPane()

    expect(screen.getByText('Ubuntu is stopped')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(/retrying/i)).not.toBeInTheDocument()
    // Showing the card is not a start: only the click may boot the distro.
    expect(connectWslHost).not.toHaveBeenCalled()
  })

  it('boots the distro on Start, refusing a pending Remove, then resumes the pane', async () => {
    const onStarted = renderStoppedPane()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce())
    expect(connectWslHost).toHaveBeenCalledWith({
      environmentId: 'env-1',
      withdrawPendingRemoval: false
    })
    expect(reloadProjects).toHaveBeenCalledWith('env-1')
  })

  it('shows why a start was refused and leaves the pane as it is', async () => {
    connectWslHost.mockRejectedValueOnce(new Error('Ubuntu is being removed.'))
    const onStarted = renderStoppedPane()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Ubuntu is being removed.'))
    expect(reloadProjects).not.toHaveBeenCalled()
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('toasts and resolves false when reconnecting after the boot fails', async () => {
    reloadProjects.mockRejectedValueOnce(new Error('Reload failed.'))
    const onStarted = renderStoppedPane()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Reload failed.'))
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('starts the distro once for repeated clicks while it boots', async () => {
    let finish!: () => void
    connectWslHost.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const onStarted = renderStoppedPane()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    finish()

    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2))
    expect(connectWslHost).toHaveBeenCalledOnce()
  })
})
