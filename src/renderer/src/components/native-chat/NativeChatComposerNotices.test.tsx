// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { CLIPBOARD_TEXT_TOO_LARGE_ERROR } from '../../../../shared/clipboard-text'
import { nativeChatNoticeFromError, setNativeChatPasteFailure } from './native-chat-composer-notice'

afterEach(cleanup)

describe('NativeChatComposerNotices', () => {
  it('draws no card when there is nothing to say, but keeps its live region for the next notice', () => {
    const { container } = render(<NativeChatComposerNotices notices={[]} />)
    expect(container.querySelectorAll('li')).toHaveLength(0)
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument()
  })

  it('puts errors first and keeps every notice, so one never hides another', () => {
    const { container } = render(
      <NativeChatComposerNotices
        notices={[
          { key: 'composer', kind: 'attachment', text: 'Worktree not ready.' },
          { key: 'session', kind: 'error', text: 'Orca couldn’t save your message.' },
          { key: 'slash', kind: 'error', text: 'sonnet-9 is not an available model.' }
        ]}
      />
    )
    const texts = screen.getAllByText(/./, { selector: 'p' }).map((node) => node.textContent)
    expect(texts).toEqual([
      'Orca couldn’t save your message.',
      'sonnet-9 is not an available model.',
      'Worktree not ready.'
    ])
    expect(container.querySelectorAll('[data-notice-kind="error"]')).toHaveLength(2)
  })

  it('shows error text Orca did not write in its own block, with a copy button', () => {
    const write = vi.fn().mockResolvedValue(undefined)
    Object.assign(window, { api: { ui: { writeClipboardText: write } } })
    render(
      <NativeChatComposerNotices
        notices={[
          {
            key: 'composer',
            kind: 'error',
            text: 'Your message was not sent.',
            errorText: 'connect ECONNREFUSED /tmp/agent-host.sock'
          }
        ]}
      />
    )
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Your message was not sent.').tagName).toBe('P')
    expect(within(row).getByText('connect ECONNREFUSED /tmp/agent-host.sock').tagName).toBe('PRE')
    fireEvent.click(within(row).getByRole('button', { name: 'Copy error' }))
    expect(write).toHaveBeenCalledWith('connect ECONNREFUSED /tmp/agent-host.sock')
  })

  it('offers the notice action and dismiss only where given', () => {
    const retry = vi.fn()
    const dismiss = vi.fn()
    render(
      <NativeChatComposerNotices
        notices={[
          {
            key: 'launch',
            kind: 'error',
            text: 'Chat could not be started.',
            action: { label: 'Retry', onClick: retry }
          },
          { key: 'composer', kind: 'attachment', text: 'Paste failed.', onDismiss: dismiss }
        ]}
      />
    )
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(1)
  })
})

describe('nativeChatNoticeFromError', () => {
  it('keeps a wrapped main-process error apart from the headline, without its wrapper', () => {
    expect(
      nativeChatNoticeFromError(
        new Error(
          "Error invoking remote method 'agentSession:send': Error: connect ECONNREFUSED /tmp/a.sock"
        ),
        'Your message was not sent.'
      )
    ).toEqual({ text: 'Your message was not sent.', errorText: 'connect ECONNREFUSED /tmp/a.sock' })
  })

  it('keeps a local error apart unless the caller says it is already Orca’s words', () => {
    const error = new Error('Pasted text is too large for this message.')
    expect(nativeChatNoticeFromError(error, 'Paste failed.')).toEqual({
      text: 'Paste failed.',
      errorText: 'Pasted text is too large for this message.'
    })
    expect(
      nativeChatNoticeFromError(error, 'Paste failed.', { localErrorIsOrcaWords: true })
    ).toEqual({ text: 'Pasted text is too large for this message.' })
  })

  it("says a paste over the size limit in Orca's words, even when it comes back from the main process", () => {
    const setNotice = vi.fn()
    setNativeChatPasteFailure(
      setNotice,
      new Error(
        `Error invoking remote method 'ui:readClipboardText': Error: ${CLIPBOARD_TEXT_TOO_LARGE_ERROR}`
      )
    )
    expect(setNotice).toHaveBeenCalledWith(CLIPBOARD_TEXT_TOO_LARGE_ERROR)
  })

  it('keeps any other main-process paste failure apart under "Paste failed."', () => {
    const setNotice = vi.fn()
    setNativeChatPasteFailure(
      setNotice,
      new Error("Error invoking remote method 'ui:readClipboardText': Error: sftp down")
    )
    expect(setNotice).toHaveBeenCalledWith('Paste failed.', 'sftp down')
  })

  it('says only the headline when the error carries no words', () => {
    expect(nativeChatNoticeFromError(new Error('   '), 'Paste failed.')).toEqual({
      text: 'Paste failed.'
    })
    expect(nativeChatNoticeFromError(undefined, 'Paste failed.')).toEqual({ text: 'Paste failed.' })
  })
})
