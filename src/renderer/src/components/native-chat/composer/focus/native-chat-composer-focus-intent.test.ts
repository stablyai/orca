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
