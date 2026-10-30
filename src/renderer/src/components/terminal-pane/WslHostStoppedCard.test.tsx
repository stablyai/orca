// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WslHostStoppedCard } from './WslHostStoppedCard'

const { reloadProjects } = vi.hoisted(() => ({ reloadProjects: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? ''),
  getIntlLocale: () => 'en-US'
}))
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: reloadProjects
}))
function renderStoppedPane(onStarted = vi.fn()) {
  render(<WslHostStoppedCard environmentId="env-1" distro="Ubuntu" onStarted={onStarted} />)
  return onStarted
}

beforeEach(() => {
  reloadProjects.mockReset().mockResolvedValue(true)
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
    expect(reloadProjects).not.toHaveBeenCalled()
  })

  it('boots the distro on Start, then resumes the pane', async () => {
    const onStarted = renderStoppedPane()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce())
    expect(reloadProjects).toHaveBeenCalledOnce()
  })

  it('leaves the pane as it is when the start fails', async () => {
    reloadProjects.mockResolvedValueOnce(false)
    const onStarted = renderStoppedPane()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))

    await waitFor(() => expect(reloadProjects).toHaveBeenCalledOnce())
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('starts the distro once for repeated clicks while it boots', async () => {
    let finish!: (started: boolean) => void
    reloadProjects.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const onStarted = renderStoppedPane()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Start' }))
    await user.click(screen.getByRole('button', { name: 'Start' }))
    finish(true)

    await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2))
    expect(reloadProjects).toHaveBeenCalledOnce()
  })
})
