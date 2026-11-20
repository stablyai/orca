// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlackConfigTokenForm } from './SlackConfigTokenForm'

const opened = vi.hoisted((): { result: string } => ({ result: 'system' }))
vi.mock('@/lib/bot-host-page', () => ({ openBotHostPageOrSay: () => opened.result }))

// Made-up values with only the prefixes Slack gives its two tokens.
const REFRESH = 'xoxe-refresh-example'
const ACCESS = 'xoxe.xoxp-access-example'

function shown(clipboard: string) {
  const onSubmit = vi.fn()
  const readClipboardText = vi.fn(async () => clipboard)
  vi.stubGlobal('api', { ui: { readClipboardText } })
  render(
    <SlackConfigTokenForm
      hostId="local"
      submitLabel="Create Slack app"
      busy={false}
      error={null}
      onSubmit={onSubmit}
    />
  )
  return { onSubmit, readClipboardText }
}

afterEach(() => {
  opened.result = 'system'
  cleanup()
  vi.unstubAllGlobals()
})

describe('SlackConfigTokenForm', () => {
  it('takes the refresh token copied in Slack when the window comes back, once', async () => {
    const { onSubmit, readClipboardText } = shown(`  ${REFRESH}\n`)
    // Nothing is read until Slack's page was opened from here.
    fireEvent.focus(window)
    expect(readClipboardText).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Get config token/ }))
    fireEvent.focus(window)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(REFRESH))
    fireEvent.focus(window)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('reads the clipboard once per opening, and not at all when Slack’s page did not open', async () => {
    const { onSubmit, readClipboardText } = shown('just some notes')
    const open = screen.getByRole('button', { name: /Get config token/ })
    fireEvent.click(open)
    fireEvent.focus(window)
    fireEvent.focus(window)
    await waitFor(() => expect(readClipboardText).toHaveBeenCalledTimes(1))
    opened.result = 'unrouted'
    fireEvent.click(open)
    fireEvent.focus(window)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('drops a read still pending when another token is pasted', async () => {
    let resolve: (text: string) => void = () => {}
    const { onSubmit, readClipboardText } = shown('')
    readClipboardText.mockReturnValue(new Promise<string>((done) => (resolve = done)))
    fireEvent.click(screen.getByRole('button', { name: /Get config token/ }))
    fireEvent.focus(window)
    fireEvent.paste(screen.getByLabelText('Configuration refresh token'), {
      clipboardData: { getData: () => REFRESH }
    })
    resolve('xoxe-older-example')
    await Promise.resolve()
    await Promise.resolve()
    expect(onSubmit.mock.calls).toEqual([[REFRESH]])
  })

  it('drops a read still pending when the form closes', async () => {
    let resolve: (text: string) => void = () => {}
    const { onSubmit, readClipboardText } = shown('')
    readClipboardText.mockReturnValue(new Promise<string>((done) => (resolve = done)))
    fireEvent.click(screen.getByRole('button', { name: /Get config token/ }))
    fireEvent.focus(window)
    cleanup()
    resolve(REFRESH)
    await Promise.resolve()
    await Promise.resolve()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends a pasted refresh token at once, and points from the access token to the other', () => {
    const { onSubmit } = shown('')
    const input = screen.getByLabelText('Configuration refresh token')
    fireEvent.paste(input, { clipboardData: { getData: () => ACCESS } })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText(/That is the Access Token/)).toBeTruthy()
    fireEvent.paste(input, { clipboardData: { getData: () => 'some other text' } })
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.paste(input, { clipboardData: { getData: () => REFRESH } })
    expect(onSubmit).toHaveBeenCalledWith(REFRESH)
    expect(screen.queryByText(/That is the Access Token/)).toBeNull()
  })
})
