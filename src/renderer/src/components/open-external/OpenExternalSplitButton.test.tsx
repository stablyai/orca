// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { OpenExternalSplitButton } from './OpenExternalSplitButton'

const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  toast.success.mockReset()
  toast.error.mockReset()
  Object.assign(window, { api: { ui: { writeClipboardText } } })
})
afterEach(cleanup)

async function copyLink(): Promise<void> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'More link options' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
}

describe('OpenExternalSplitButton', () => {
  it('runs the main action unchanged and never copies on it', async () => {
    const onOpen = vi.fn()
    render(
      <OpenExternalSplitButton link="https://auth.openai.com/codex/device" onClick={onOpen}>
        Copy code and open
      </OpenExternalSplitButton>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Copy code and open' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('copies the exact URL from the chevron without opening it', async () => {
    const onOpen = vi.fn()
    render(
      <OpenExternalSplitButton link="https://auth.openai.com/codex/device" onClick={onOpen}>
        Open page
      </OpenExternalSplitButton>
    )
    await copyLink()
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith('https://auth.openai.com/codex/device')
    )
    expect(onOpen).not.toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('Link copied')
    // A brief check on the chevron confirms the copy.
    await waitFor(() =>
      expect(document.querySelector('[data-open-external-chevron] svg.lucide-check')).not.toBeNull()
    )
  })

  it('a loopback sign-in link says where it works, in the menu and once copied', async () => {
    render(
      <OpenExternalSplitButton
        link="http://127.0.0.1:5555/auth?state=s"
        copyHint="Open it in any browser on this computer."
        onClick={vi.fn()}
      >
        Sign in
      </OpenExternalSplitButton>
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More link options' }))
    const item = await screen.findByRole('menuitem', { name: /Copy link/ })
    expect(item.textContent).toContain('Open it in any browser on this computer.')
    await user.click(item)
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Link copied', {
        description: 'Open it in any browser on this computer.'
      })
    )
  })

  it('mints a lazy URL the same way on Copy link, then copies it without opening', async () => {
    const onOpen = vi.fn()
    const mint = vi.fn(async () => 'https://billing.stripe.com/p/session/test_123')
    render(
      <OpenExternalSplitButton link={mint} onClick={onOpen}>
        Update payment method
      </OpenExternalSplitButton>
    )
    // Nothing is minted until someone asks for the link.
    expect(mint).not.toHaveBeenCalled()
    await copyLink()
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith(
        'https://billing.stripe.com/p/session/test_123'
      )
    )
    expect(mint).toHaveBeenCalledTimes(1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('says nothing more when a lazy source already explained there is no link', async () => {
    render(
      <OpenExternalSplitButton link={async () => null} onClick={() => {}}>
        Open
      </OpenExternalSplitButton>
    )
    await copyLink()
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('tells the person when minting or copying fails', async () => {
    render(
      <OpenExternalSplitButton
        link={async () => {
          throw new Error('offline')
        }}
        onClick={() => {}}
      >
        Open
      </OpenExternalSplitButton>
    )
    await copyLink()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t copy the link.'))
    expect(writeClipboardText).not.toHaveBeenCalled()
  })

  it('reports a clipboard failure instead of claiming the copy', async () => {
    writeClipboardText.mockRejectedValueOnce(new Error('denied'))
    render(
      <OpenExternalSplitButton link="https://claude.ai/oauth" onClick={() => {}}>
        Open again
      </OpenExternalSplitButton>
    )
    await copyLink()
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Couldn’t copy the link.'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
