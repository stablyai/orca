import { describe, expect, it } from 'vitest'
import { shouldFocusMobileDriverAction } from './mobile-driver-overlay-focus'

function focusLike(args: {
  tagName?: string
  xterm?: boolean
  contentEditable?: boolean
  editableAncestor?: boolean
  selfMatchesEditable?: boolean
}): {
  tagName?: string
  isContentEditable: boolean
  classList: { contains: (token: string) => boolean }
  closest: (selector: string) => unknown
  contains: (node: unknown) => boolean
} {
  const element = {
    tagName: args.tagName,
    isContentEditable: args.contentEditable === true,
    classList: {
      contains: (token: string) => args.xterm === true && token === 'xterm-helper-textarea'
    },
    closest: (selector: string) =>
      (args.editableAncestor === true || args.selfMatchesEditable === true) &&
      selector === 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
        ? {}
        : null,
    contains: (node: unknown) => node === element
  }

  return element
}

function scopeContaining(node: unknown): { contains: (candidate: unknown) => boolean } {
  return {
    contains: (candidate: unknown) => candidate === node
  }
}

describe('shouldFocusMobileDriverAction', () => {
  it('focuses the recovery action when focus is neutral', () => {
    const body = focusLike({})

    expect(shouldFocusMobileDriverAction(null, body)).toBe(true)
    expect(shouldFocusMobileDriverAction(body, body)).toBe(true)
  })

  it('preserves focus for real editable app controls', () => {
    expect(
      shouldFocusMobileDriverAction(focusLike({ tagName: 'INPUT', selfMatchesEditable: true }))
    ).toBe(false)
    expect(
      shouldFocusMobileDriverAction(focusLike({ tagName: 'TEXTAREA', selfMatchesEditable: true }))
    ).toBe(false)
    expect(
      shouldFocusMobileDriverAction(focusLike({ tagName: 'SELECT', selfMatchesEditable: true }))
    ).toBe(false)
    expect(shouldFocusMobileDriverAction(focusLike({ editableAncestor: true }))).toBe(false)
    expect(shouldFocusMobileDriverAction(focusLike({ contentEditable: true }))).toBe(false)
  })

  it('still focuses the recovery action for xterm helper textareas', () => {
    const xterm = focusLike({ tagName: 'TEXTAREA', xterm: true })

    expect(shouldFocusMobileDriverAction(xterm, undefined, scopeContaining(xterm))).toBe(true)
  })

  it('preserves focus for xterm helper textareas outside the overlay pane', () => {
    const xterm = focusLike({ tagName: 'TEXTAREA', xterm: true })

    expect(shouldFocusMobileDriverAction(xterm, undefined, scopeContaining({}))).toBe(false)
    expect(shouldFocusMobileDriverAction(xterm)).toBe(false)
  })

  it('preserves browser guest focus represented by Electron webviews', () => {
    expect(shouldFocusMobileDriverAction(focusLike({ tagName: 'WEBVIEW' }))).toBe(false)
  })
})
