// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name]))
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dispatchNativeChatStructuredComposerText', () => {
  it('rejects an attachment exceeding 5MB with diagnostic error', async () => {
    const stat = vi.fn().mockResolvedValue({ size: 5 * 1024 * 1024 + 100 })
    vi.stubGlobal('api', { fs: { stat } })

    const send = vi.fn()
    const dispatchCommand = vi.fn().mockResolvedValue({ handled: false, accepted: true })
    const transport: NativeChatStructuredComposerTransport = {
      send,
      dispatchCommand,
      capturePresentation: () => () => true
    } as unknown as NativeChatStructuredComposerTransport

    const attachments = [{ id: 'img-1', path: '/path/to/screenshot.png' }]

    const outcome = await dispatchNativeChatStructuredComposerText(
      transport,
      'look at this image',
      attachments
    )

    expect(outcome.accepted).toBe(false)
    expect(outcome.error).toBe(
      'Image #1 (screenshot.png, 5.1 MB) is larger than 5 MB, so the message was not sent.'
    )
    expect(attachments[0]).toMatchObject({
      failed: true,
      error: 'Image #1 (screenshot.png, 5.1 MB) is larger than 5 MB, so the message was not sent.'
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('allows attachments within 5MB limit', async () => {
    const stat = vi.fn().mockResolvedValue({ size: 2 * 1024 * 1024 })
    vi.stubGlobal('api', { fs: { stat } })

    const send = vi.fn().mockReturnValue(true)
    const dispatchCommand = vi.fn().mockResolvedValue({ handled: false, accepted: true })
    const transport: NativeChatStructuredComposerTransport = {
      send,
      dispatchCommand,
      capturePresentation: () => () => true
    } as unknown as NativeChatStructuredComposerTransport

    const attachments = [{ id: 'img-1', path: '/path/to/normal.png' }]

    const outcome = await dispatchNativeChatStructuredComposerText(
      transport,
      'look at this image',
      attachments
    )

    expect(outcome.accepted).toBe(true)
    expect(outcome.error).toBeNull()
    expect(send).toHaveBeenCalled()
  })
})
