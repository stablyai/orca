// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlackConfigTokenForm } from './SlackConfigTokenForm'

// This computer's browser: whether it takes the page, and every page it was given.
const opened: { fails: boolean; urls: string[] } = { fails: false, urls: [] }
const openUrl = async (url: string): Promise<void> => {
  opened.urls.push(url)
  if (opened.fails) {
    throw new Error('no default browser')
  }
}

// Made-up values with only the prefixes Slack gives its two tokens.
const REFRESH = 'xoxe-refresh-example'
const ACCESS = 'xoxe.xoxp-access-example'

function shown(clipboard: string) {
  const onSubmit = vi.fn()
  const readClipboardText = vi.fn(async () => clipboard)
  vi.stubGlobal('api', { ui: { readClipboardText }, shell: { openUrl } })
  render(
    <SlackConfigTokenForm
      submitLabel="Create Slack app"
      busy={false}
      error={null}
      onSubmit={onSubmit}
    />
  )
  return { onSubmit, readClipboardText }
}

/** Clicks Get config token and lets the browser's answer land. */
async function getConfigToken(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /Get config token/ }))
  await act(async () => {})
}

afterEach(() => {
  opened.fails = false
  opened.urls = []
  cleanup()
  vi.unstubAllGlobals()
})

describe('SlackConfigTokenForm', () => {
  it("opens Slack's page in this computer's browser", async () => {
    shown('')
    await getConfigToken()
    expect(opened.urls).toEqual(['https://api.slack.com/apps'])
  })

  it('fills the field with the token copied in Slack when the window comes back, and sends only on submit', async () => {
    const { onSubmit, readClipboardText } = shown(`  ${REFRESH}\n`)
    // Nothing is read until Slack's page was opened from here.
    fireEvent.focus(window)
    expect(readClipboardText).not.toHaveBeenCalled()
    await getConfigToken()
    fireEvent.focus(window)
    const field = screen.getByLabelText<HTMLInputElement>('Configuration refresh token')
    await waitFor(() => expect(field.value).toBe(REFRESH))
    fireEvent.focus(window)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.submit(field.closest('form')!)
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(REFRESH)
  })

  it('reads the clipboard once per opening, and not at all when Slack’s page did not open', async () => {
    const { onSubmit, readClipboardText } = shown('just some notes')
    await getConfigToken()
    fireEvent.focus(window)
    fireEvent.focus(window)
    await waitFor(() => expect(readClipboardText).toHaveBeenCalledTimes(1))
    opened.fails = true
    await getConfigToken()
    fireEvent.focus(window)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    ['opened, then failed', [true, false]],
    ['failed, then opened', [false, true]]
  ])('keeps the read a launch armed when another one fails (%s)', async (_, outcomes) => {
    const { readClipboardText } = shown(REFRESH)
    const settle: (() => void)[] = []
    vi.stubGlobal('api', {
      ui: { readClipboardText },
      shell: {
        openUrl: () =>
          new Promise<void>((resolve, reject) => {
            const ok = outcomes[settle.length]
            settle.push(() => (ok ? resolve() : reject(new Error('no default browser'))))
          })
      }
    })
    const open = screen.getByRole('button', { name: /Get config token/ })
    fireEvent.click(open)
    fireEvent.click(open)
    await act(async () => settle[0]())
    await act(async () => settle[1]())
    fireEvent.focus(window)
    const field = screen.getByLabelText<HTMLInputElement>('Configuration refresh token')
    await waitFor(() => expect(field.value).toBe(REFRESH))
  })

  it.each([
    ['first launch answers first', [0, 1]],
    ['second launch answers first', [1, 0]]
  ])('reads once across two launches, never over what was typed (%s)', async (_, order) => {
    const { readClipboardText } = shown(REFRESH)
    const settle: (() => void)[] = []
    vi.stubGlobal('api', {
      ui: { readClipboardText },
      shell: { openUrl: () => new Promise<void>((resolve) => settle.push(resolve)) }
    })
    const open = screen.getByRole('button', { name: /Get config token/ })
    fireEvent.click(open)
    fireEvent.click(open)
    await act(async () => settle[order[0]]())
    fireEvent.focus(window)
    const field = screen.getByLabelText<HTMLInputElement>('Configuration refresh token')
    await waitFor(() => expect(field.value).toBe(REFRESH))
    fireEvent.change(field, { target: { value: 'xoxe-typed-by-hand' } })
    await act(async () => settle[order[1]]())
    fireEvent.focus(window)
    await act(async () => {})
    expect(readClipboardText).toHaveBeenCalledTimes(1)
    expect(field.value).toBe('xoxe-typed-by-hand')
  })

  it('drops a read still pending when another token is pasted', async () => {
    let resolve: (text: string) => void = () => {}
    const { onSubmit, readClipboardText } = shown('')
    readClipboardText.mockReturnValue(new Promise<string>((done) => (resolve = done)))
    await getConfigToken()
    fireEvent.focus(window)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
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
    await getConfigToken()
    fireEvent.focus(window)
    expect(readClipboardText).toHaveBeenCalledTimes(1)
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
