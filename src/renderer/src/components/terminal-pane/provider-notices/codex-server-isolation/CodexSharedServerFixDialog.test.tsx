// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexSharedServerFixDialog } from './CodexSharedServerFixDialog'

const disable = vi.fn<(ptyId: string) => Promise<boolean>>()
const stop = vi.fn<(ptyId: string) => Promise<boolean>>()

function renderFix(): {
  onOpenChange: ReturnType<typeof vi.fn>
  onServerStopped: ReturnType<typeof vi.fn>
} {
  const onOpenChange = vi.fn()
  const onServerStopped = vi.fn()
  render(
    <CodexSharedServerFixDialog
      ptyId="pty-1"
      open
      onOpenChange={onOpenChange}
      onServerStopped={onServerStopped}
    />
  )
  return { onOpenChange, onServerStopped }
}

async function clickButton(name: string): Promise<void> {
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name }))
  })
}

beforeEach(() => {
  disable.mockReset()
  stop.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: { disableCodexSharedServerAutoStart: disable, stopCodexSharedServer: stop },
      ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
    }
  })
})
afterEach(cleanup)

describe('CodexSharedServerFixDialog', () => {
  it('runs nothing else when turning sharing off fails', async () => {
    disable.mockResolvedValue(false)
    const { onOpenChange } = renderFix()
    await userEvent.click(screen.getByRole('checkbox'))
    await clickButton('Turn off sharing')

    expect(stop).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t turn off sharing.')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('only turns sharing off when the stop box is left unchecked', async () => {
    disable.mockResolvedValue(true)
    const { onOpenChange, onServerStopped } = renderFix()
    await clickButton('Turn off sharing')

    expect(disable).toHaveBeenCalledWith('pty-1')
    expect(stop).not.toHaveBeenCalled()
    expect(onServerStopped).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('stops the server after turning sharing off when the box is checked', async () => {
    disable.mockResolvedValue(true)
    stop.mockResolvedValue(true)
    const { onOpenChange, onServerStopped } = renderFix()
    await userEvent.click(screen.getByRole('checkbox'))
    await clickButton('Turn off sharing')

    expect(disable.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0])
    expect(onServerStopped).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps sharing off and retries only the stop after the stop fails', async () => {
    disable.mockResolvedValue(true)
    stop.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { onOpenChange, onServerStopped } = renderFix()
    await userEvent.click(screen.getByRole('checkbox'))
    await clickButton('Turn off sharing')

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Sharing is off, but the server didn’t stop.'
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    await clickButton('Stop server')
    expect(disable).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(onServerStopped).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
