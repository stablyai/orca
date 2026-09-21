// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isSelectAllShortcut } from './editable-target'

const originalUserAgent = navigator.userAgent

function setPlatformUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

function keyEvent(overrides: Partial<Parameters<typeof isSelectAllShortcut>[0]> = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    key: 'a',
    metaKey: false,
    shiftKey: false,
    ...overrides
  }
}

afterEach(() => setPlatformUserAgent(originalUserAgent))

describe('isSelectAllShortcut', () => {
  it.each([
    ['macOS Cmd+A', 'Macintosh', { metaKey: true }],
    ['Linux Ctrl+A', 'Linux x86_64', { ctrlKey: true }],
    ['Windows Ctrl+A', 'Windows NT 10.0', { ctrlKey: true }]
  ])('recognizes %s', (_label, userAgent, modifiers) => {
    setPlatformUserAgent(userAgent)

    expect(isSelectAllShortcut(keyEvent(modifiers))).toBe(true)
  })

  it.each([
    ['macOS Ctrl+A', 'Macintosh', { ctrlKey: true }],
    ['Linux Cmd+A', 'Linux x86_64', { metaKey: true }],
    ['Windows Cmd+A', 'Windows NT 10.0', { metaKey: true }]
  ])('rejects wrong-modifier %s', (_label, userAgent, modifiers) => {
    setPlatformUserAgent(userAgent)

    expect(isSelectAllShortcut(keyEvent(modifiers))).toBe(false)
  })
})
