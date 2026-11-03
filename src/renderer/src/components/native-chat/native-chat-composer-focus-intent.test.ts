// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureNativeChatComposerFocusIntent,
  registerNativeChatComposerReclaim,
  type NativeChatComposerFocusIntent
} from './native-chat-composer-focus-intent'

let intent: NativeChatComposerFocusIntent | undefined
let unregister: (() => void) | undefined

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  intent?.cancel()
  unregister?.()
  document.body.replaceChildren()
  vi.useRealTimers()
})

function mountDestination(): HTMLTextAreaElement {
  const composer = document.createElement('textarea')
  document.body.append(composer)
  unregister = registerNativeChatComposerReclaim('destination', () => composer.focus(), composer)
  return composer
}

function mountSource(role: string): HTMLDivElement {
  const source = document.createElement('div')
  source.setAttribute('role', role)
  source.tabIndex = -1
  document.body.append(source)
  source.focus()
  intent = captureNativeChatComposerFocusIntent()
  intent.request('destination')
  expect(document.activeElement).toBe(source)
  return source
}

describe('custom overlay launch handoff', () => {
  it.each(['dialog', 'menu'])(
    'delivers to an already registered destination when a custom %s is removed',
    async (role) => {
      const composer = mountDestination()
      const source = mountSource(role)

      source.remove()
      await vi.advanceTimersByTimeAsync(0)

      expect(document.activeElement).toBe(composer)
    }
  )

  it.each(['display', 'visibility', 'class', 'hidden'])(
    'delivers when a retained source is hidden via %s',
    async (dismissal) => {
      const stylesheet = document.createElement('style')
      stylesheet.textContent = '.dismissed-overlay, [hidden] { display: none; }'
      document.body.append(stylesheet)
      const composer = mountDestination()
      const source = mountSource('dialog')

      if (dismissal === 'display') {
        source.style.display = 'none'
      }
      if (dismissal === 'visibility') {
        source.style.visibility = 'hidden'
      }
      if (dismissal === 'class') {
        source.className = 'dismissed-overlay'
      }
      if (dismissal === 'hidden') {
        source.hidden = true
      }
      await vi.advanceTimersByTimeAsync(0)

      expect(source.isConnected).toBe(true)
      expect(document.activeElement).toBe(composer)
    }
  )

  it('waits for a source that is still painted during its exit animation', async () => {
    const composer = mountDestination()
    const source = mountSource('dialog')
    source.dataset.state = 'closed'
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).toBe(source)

    source.remove()
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).toBe(composer)
  })

  it('releases a hidden source when delivery is requested before mutation notification', () => {
    const composer = mountDestination()
    const source = mountSource('menu')

    source.style.display = 'none'
    intent?.request('destination')

    expect(source.isConnected).toBe(true)
    expect(document.activeElement).toBe(composer)
  })

  it('keeps an accessibility-hidden parent source until it actually dismisses', async () => {
    const composer = mountDestination()
    const source = mountSource('dialog')
    source.setAttribute('aria-hidden', 'true')
    source.className = 'still-open'
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).toBe(source)

    source.style.display = 'none'
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).toBe(composer)
  })

  it('cancels when a newer custom overlay appears before dismissal', async () => {
    const composer = mountDestination()
    const source = mountSource('menu')
    const newer = document.createElement('div')
    newer.setAttribute('role', 'dialog')
    newer.tabIndex = -1
    document.body.append(newer)
    newer.focus()
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).toBe(newer)

    source.remove()
    newer.remove()
    await vi.advanceTimersByTimeAsync(0)
    expect(document.activeElement).not.toBe(composer)
  })
})
