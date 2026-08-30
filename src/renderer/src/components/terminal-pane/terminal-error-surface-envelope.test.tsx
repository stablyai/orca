// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bindAttachRetainedLegacyPty } from './pty-connection/retained-legacy-pty-attach'
import { appendTerminalErrorMessage } from './terminal-error-accumulation'
import { formatClipboardImagePasteError } from './terminal-paste-errors'
import { TerminalErrorToast } from './TerminalErrorToast'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'

vi.mock('@/lib/client-environment-info', () => ({
  resolveClientEnvironmentFooter: vi.fn().mockResolvedValue('')
}))

afterEach(() => {
  cleanup()
})

const ENVELOPE_PREFIX = 'Error invoking remote method'
// The exact shape Electron rethrows in the renderer when a `pty:` handler rejects.
const WRAPPED_ATTACH_FAILURE = `Error invoking remote method 'pty:attach': Error: EACCES: permission denied, open '/srv/sessions/pty-7.sock'`
const REASON = "EACCES: permission denied, open '/srv/sessions/pty-7.sock'"

/** Drives the real producer, then the real accumulator, then renders the real toast. */
function renderSurfaceFor(rejection: Error): string {
  const reported: string[] = []
  const session = {
    authoritativeReattachGeneration: 0,
    clearPaneMode2031State: () => {},
    clearHiddenOutputRestoreState: () => {},
    captureTransportOutputCallbacks: () => ({ generation: 1, callbacks: {} }),
    transport: {
      attach: () => {
        throw rejection
      },
      getPtyId: () => null
    },
    bindActivePanePty: () => {},
    registerPaneSerializerFor: () => {},
    reportError: (message: string) => {
      reported.push(message)
    }
  } as unknown as ConnectPanePtySession

  bindAttachRetainedLegacyPty(session)
  expect(session.attachRetainedLegacyPty('pty-7')).toBe(false)
  expect(reported).toHaveLength(1)

  const accumulated = reported.reduce<string | null>(
    (previous, message) => appendTerminalErrorMessage(previous, message),
    null
  )
  expect(accumulated).not.toBeNull()

  const { container } = render(
    <TerminalErrorToast error={accumulated as string} onDismiss={() => {}} />
  )
  return container.textContent ?? ''
}

describe('the terminal error surface', () => {
  it('renders the reason a wrapped attach failure carries, not Electron’s envelope', () => {
    const rendered = renderSurfaceFor(new Error(WRAPPED_ATTACH_FAILURE))

    expect(rendered).toContain(REASON)
    expect(rendered).not.toContain(ENVELOPE_PREFIX)
    expect(rendered).not.toContain("'pty:attach'")
  })

  it('renders copy rather than the envelope when the rejection carried no reason', () => {
    // Absent is not empty: a message-less rejection arrives as a bare class name behind the
    // envelope, so the tail is present and non-empty yet still carries no reason to show.
    const rendered = renderSurfaceFor(new Error(`Error invoking remote method 'pty:attach': Error`))

    expect(rendered).not.toContain(ENVELOPE_PREFIX)
    expect(rendered).toContain('did not include a readable reason')
  })

  it('keeps the whole multi-line reason a wrapped git failure carries', () => {
    // Why here: the accumulator joins with newlines, so a multi-line reason is the case its own
    // dedup comment calls out — and it only reaches this surface intact now that the stripper
    // no longer stops at the first newline.
    const multiline = 'fatal: could not read Username\nfatal: Authentication failed'
    const rendered = renderSurfaceFor(
      new Error(`Error invoking remote method 'pty:attach': Error: ${multiline}`)
    )

    expect(rendered).toContain('fatal: could not read Username')
    expect(rendered).toContain('fatal: Authentication failed')
    expect(rendered).not.toContain(ENVELOPE_PREFIX)
  })
})

describe('the clipboard-image paste door into the same surface', () => {
  // Why a separate door: this path calls setTerminalError directly, so the accumulator never sees
  // the value. A fix that only covered the accumulator would leave this envelope on screen.
  const WRAPPED_STAGING_FAILURE = new Error(
    `Error invoking remote method 'clipboard:saveImageAsTempFile': Error: ENOSPC: no space left on device`
  )

  it('renders the staging reason, not Electron’s envelope', () => {
    const { container } = render(
      <TerminalErrorToast
        error={formatClipboardImagePasteError(WRAPPED_STAGING_FAILURE)}
        onDismiss={() => {}}
      />
    )

    expect(container.textContent).toContain('ENOSPC: no space left on device')
    expect(container.textContent).not.toContain(ENVELOPE_PREFIX)
  })

  it('renders copy rather than the envelope when the staging rejection carried no reason', () => {
    const message = formatClipboardImagePasteError(
      new Error(`Error invoking remote method 'clipboard:saveImageAsTempFile': Error`)
    )

    expect(message).not.toContain(ENVELOPE_PREFIX)
    expect(message).toContain('did not include a readable reason')
  })

  it('still shows the reason a non-Error rejection carries', () => {
    // Absent is not empty: a nullish rejection has no reason, but a thrown string does.
    expect(formatClipboardImagePasteError('disk is read-only')).toContain('disk is read-only')
    expect(formatClipboardImagePasteError(null)).toContain('did not include a readable reason')
  })
})
