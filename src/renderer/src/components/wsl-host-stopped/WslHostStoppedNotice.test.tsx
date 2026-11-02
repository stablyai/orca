// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WslHostStoppedNotice } from './WslHostStoppedNotice'

const start = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())

vi.mock('@/lib/wsl-host-user-start', () => ({
  startWslHostAndReloadProjects: start
}))

afterEach(() => {
  cleanup()
  start.mockReset()
})

describe('WslHostStoppedNotice', () => {
  it('names the stopped distro and boots it only on Start (E9)', async () => {
    let finish: (started: boolean) => void = () => {}
    start.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
    )
    const onStarted = vi.fn()
    const view = render(
      <WslHostStoppedNotice environmentId="wsl:ubuntu" distro="Ubuntu" onStarted={onStarted} />
    )
    expect(view.getByText('Ubuntu is stopped')).toBeTruthy()
    expect(start).not.toHaveBeenCalled()

    const button = view.getByRole('button', { name: 'Start' })
    fireEvent.click(button)
    expect(start).toHaveBeenCalledWith('wsl:ubuntu')
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(onStarted).not.toHaveBeenCalled()

    await act(async () => finish(true))
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('does not report a failed start as started', async () => {
    start.mockResolvedValue(false)
    const onStarted = vi.fn()
    const view = render(
      <WslHostStoppedNotice environmentId="wsl:ubuntu" distro="Ubuntu" onStarted={onStarted} />
    )
    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Start' })))
    expect(onStarted).not.toHaveBeenCalled()
  })
})
