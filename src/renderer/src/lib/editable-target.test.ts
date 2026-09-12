// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { isEditableTarget, isSelectAllShortcut } from './editable-target'

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

it('reserves shortcuts for a retargeted shadow host and its read-only surface', () => {
  const surface = document.createElement('div')
  surface.setAttribute('data-editor-keyboard-scope', '')
  const host = document.createElement('diffs-container')
  surface.append(host)
  expect(isEditableTarget(surface)).toBe(true)
  expect(isEditableTarget(host)).toBe(true)
  expect(isEditableTarget(document.createElement('div'))).toBe(false)
})

it('preserves normal input handling and the terminal textarea exception', () => {
  const input = document.createElement('textarea')
  expect(isEditableTarget(input)).toBe(true)
  input.className = 'xterm-helper-textarea'
  expect(isEditableTarget(input)).toBe(false)
})
