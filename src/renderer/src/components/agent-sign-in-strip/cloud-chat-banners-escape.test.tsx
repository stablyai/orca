// @vitest-environment happy-dom
// END-PASS CHAT-RENEW: Escape in a chat (focus in its composer) stops a sign-in or renewal that is
// mid-flow and goes back to step 1, like the strip's ×; otherwise Escape is left to the composer.
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudStripModel } from './cloud-agent-strip-model'

const strip = vi.hoisted(() => {
  const value: { model: CloudStripModel | null; cancel: ReturnType<typeof vi.fn> } = {
    model: null,
    cancel: vi.fn()
  }
  return value
})

vi.mock('./use-cloud-held-strip', () => ({
  useCloudHeldStrip: () => ({
    key: 'structured:s1',
    active: strip.model !== null,
    strip: strip.model
      ? {
          model: strip.model,
          prompt: null,
          actions: {
            primary: () => undefined,
            submitCode: () => undefined,
            pasteCode: () => undefined,
            useCode: () => undefined,
            useApiKey: () => undefined,
            cancel: strip.cancel
          }
        }
      : null
  })
}))
vi.mock('./use-cloud-chat-running-strip', () => ({ useCloudChatRunningStrip: () => null }))
vi.mock('./CloudAgentSignInStrip', () => ({
  CloudAgentSignInStrip: () => <div data-cloud-sign-in-strip="" />
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ unifiedTabsByWorktree: {} }) } }))

const { CloudStructuredChatBanners } = await import('./CloudStructuredChatBanners')

const base: CloudStripModel = {
  status: 'busy',
  title: 'Your Claude sign-in expired',
  detail: 'Finish in your browser, then paste the code here.',
  description: null,
  primary: { label: 'Open again', action: { kind: 'reopenSetup' } },
  code: null,
  paste: { submitting: false, refusal: null },
  otherWays: false,
  announcement: ''
}

function mount(): HTMLTextAreaElement {
  const { container } = render(
    <div data-native-chat-root="">
      <CloudStructuredChatBanners
        tabId="t1"
        paneKey="structured:s1"
        statusKey="t1:s1"
        agent="claude"
      />
      <textarea data-composer="" />
    </div>
  )
  return container.querySelector('textarea')!
}

const escape = (target: Element) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  strip.cancel.mockReset()
})
afterEach(cleanup)

describe('Escape in a chat with a sign-in mid-flow', () => {
  it('stops it (back to step 1) and the composer never sees that Escape', () => {
    strip.model = base
    const event = escape(mount())
    expect(strip.cancel).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })

  it('step 1 (Renew, nothing running) leaves Escape to the composer', () => {
    strip.model = {
      ...base,
      status: 'warning',
      primary: { label: 'Renew', action: { kind: 'renew' } },
      paste: null
    }
    const event = escape(mount())
    expect(strip.cancel).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('an Escape outside this chat is not taken', () => {
    strip.model = base
    mount()
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    escape(elsewhere)
    expect(strip.cancel).not.toHaveBeenCalled()
  })
})
