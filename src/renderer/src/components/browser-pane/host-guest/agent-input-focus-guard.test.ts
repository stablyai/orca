// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginAgentInputFocusGuard,
  clearAgentInputFocusGuards,
  endAgentInputFocusGuard
} from './agent-input-focus-guard'
import { webviewRegistry } from './webview-registry'

function mountPage(browserPageId: string): HTMLElement {
  const webview = document.createElement('div')
  webview.tabIndex = 0
  document.body.append(webview)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only uses focus and blur, which a focusable div provides.
  webviewRegistry.set(browserPageId, webview as unknown as Electron.WebviewTag)
  return webview
}

function focusTerminal(): HTMLTextAreaElement {
  const terminal = document.createElement('textarea')
  document.body.append(terminal)
  terminal.focus()
  return terminal
}

describe('agent input focus guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clearAgentInputFocusGuards()
    vi.runAllTimers()
    vi.useRealTimers()
    webviewRegistry.clear()
    document.body.replaceChildren()
  })

  it('leaves the page focused during the input and returns focus to the user when it ends', () => {
    const webview = mountPage('page-1')
    const terminal = focusTerminal()

    beginAgentInputFocusGuard('page-1', 'input-1')
    webview.focus()
    expect(document.activeElement).toBe(webview)
    endAgentInputFocusGuard('input-1')

    expect(document.activeElement).toBe(terminal)
  })

  it('catches the input’s focus move when it arrives after the end message', () => {
    const webview = mountPage('page-1')
    const terminal = focusTerminal()

    beginAgentInputFocusGuard('page-1', 'input-1')
    endAgentInputFocusGuard('input-1')
    webview.focus()
    vi.advanceTimersByTime(50)

    expect(document.activeElement).toBe(terminal)
  })

  it('leaves focus in the page when the user was already there', () => {
    const webview = mountPage('page-1')
    webview.focus()

    beginAgentInputFocusGuard('page-1', 'input-1')
    endAgentInputFocusGuard('input-1')
    vi.advanceTimersByTime(50)

    expect(document.activeElement).toBe(webview)
  })

  it('blurs the page when nothing held focus before the input', () => {
    const webview = mountPage('page-1')

    beginAgentInputFocusGuard('page-1', 'input-1')
    webview.focus()
    endAgentInputFocusGuard('input-1')

    expect(document.activeElement).not.toBe(webview)
  })

  it('does not move focus the user put somewhere else meanwhile', () => {
    const webview = mountPage('page-1')
    focusTerminal()
    const other = document.createElement('input')
    document.body.append(other)

    beginAgentInputFocusGuard('page-1', 'input-1')
    webview.focus()
    other.focus()
    endAgentInputFocusGuard('input-1')

    expect(document.activeElement).toBe(other)
  })

  it('returns focus to the user when agents press two pages at once', () => {
    const pageA = mountPage('page-a')
    const pageB = mountPage('page-b')
    const terminal = focusTerminal()

    beginAgentInputFocusGuard('page-a', 'input-a')
    pageA.focus()
    beginAgentInputFocusGuard('page-b', 'input-b')
    endAgentInputFocusGuard('input-a')
    pageB.focus()
    endAgentInputFocusGuard('input-b')
    vi.advanceTimersByTime(50)

    expect(document.activeElement).toBe(terminal)
  })

  it('guards a second press that starts while the first is still settling', () => {
    const webview = mountPage('page-1')
    const terminal = focusTerminal()

    beginAgentInputFocusGuard('page-1', 'input-1')
    endAgentInputFocusGuard('input-1')
    webview.focus()
    beginAgentInputFocusGuard('page-1', 'input-2')
    vi.advanceTimersByTime(50)
    webview.focus()
    endAgentInputFocusGuard('input-2')

    expect(document.activeElement).toBe(terminal)
  })

  it('gives focus back when an end message never arrives', () => {
    const webview = mountPage('page-1')
    const terminal = focusTerminal()

    beginAgentInputFocusGuard('page-1', 'input-1')
    webview.focus()
    vi.advanceTimersByTime(30_000)

    expect(document.activeElement).toBe(terminal)
  })
})
