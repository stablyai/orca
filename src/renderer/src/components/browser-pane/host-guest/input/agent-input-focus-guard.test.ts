// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginAgentInputFocusGuard,
  clearAgentInputFocusGuards,
  endAgentInputFocusGuard,
  watchUserComposition
} from './agent-input-focus-guard'
import { webviewRegistry } from '../webview-registry'
import { installBrowserClientPageRenderer } from '../client-pages/browser-client-page-renderer-installation'
import { BrowserClientPageRetainedRegistry } from '../client-pages/browser-client-page-retained-registry'
import { clearBrowserGuestMetadata } from '../metadata/browser-guest-metadata-cache'

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

function compose(
  element: HTMLElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data = ''
): void {
  element.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }))
}

describe('agent input focus guard', () => {
  let unwatchUserComposition: () => void
  let disposeClientPages: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    unwatchUserComposition = watchUserComposition()
  })

  afterEach(() => {
    unwatchUserComposition()
    clearAgentInputFocusGuards()
    vi.runAllTimers()
    vi.useRealTimers()
    disposeClientPages?.()
    disposeClientPages = undefined
    clearBrowserGuestMetadata()
    webviewRegistry.clear()
    document.body.replaceChildren()
  })

  it('treats a nonempty update as an open composition and an empty one as not ending it', () => {
    mountPage('page-1')
    const terminal = focusTerminal()

    compose(terminal, 'compositionupdate', 'zhong')
    expect(beginAgentInputFocusGuard('page-1', 41, 'input-1')).toBe('composing')
    compose(terminal, 'compositionupdate', '')
    expect(beginAgentInputFocusGuard('page-1', 41, 'input-2')).toBe('composing')
    compose(terminal, 'compositionend')
    expect(beginAgentInputFocusGuard('page-1', 41, 'input-3')).toBe('ready')
  })

  it('keeps a Cangjie composition open through its own input and Backspace', () => {
    mountPage('page-1')
    const terminal = focusTerminal()
    const composingInput = (inputType?: string): InputEvent =>
      new InputEvent('input', { bubbles: true, isComposing: true, inputType })

    // Recorded: compose 尸 and 口, then Backspace leaves 尸 unfinished.
    compose(terminal, 'compositionstart')
    compose(terminal, 'compositionupdate', '尸')
    terminal.dispatchEvent(composingInput())
    compose(terminal, 'compositionupdate', '尸口')
    terminal.dispatchEvent(composingInput())
    compose(terminal, 'compositionupdate', '尸')
    terminal.dispatchEvent(composingInput('deleteContentBackward'))

    expect(beginAgentInputFocusGuard('page-1', 41, 'input-1')).toBe('composing')
  })

  it('guards a press once the composition ended by typing or the user left it', () => {
    mountPage('page-1')
    const terminal = focusTerminal()

    compose(terminal, 'compositionstart')
    terminal.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    expect(beginAgentInputFocusGuard('page-1', 41, 'input-1')).toBe('ready')
    endAgentInputFocusGuard('input-1')

    compose(terminal, 'compositionstart')
    terminal.blur()
    expect(beginAgentInputFocusGuard('page-1', 41, 'input-2')).toBe('ready')
  })

  it('gives the user focus back from the This-device page that agent input moved it into', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry and guard use only DOM events, dataset, focus and the getWebContentsId defined below.
    const page = document.createElement('webview') as Electron.WebviewTag
    page.tabIndex = 0
    Object.defineProperty(page, 'getWebContentsId', { value: () => 41 })
    const registry = new BrowserClientPageRetainedRegistry({ document, createWebview: () => page })
    const installation = installBrowserClientPageRenderer({ registry, subscribe: () => () => {} })
    if (!installation) {
      throw new Error('the client page renderer did not install')
    }
    disposeClientPages = () => installation.dispose()
    const mounting = registry.mountPage({
      partition: 'persist:route-a',
      browserPageId: 'page-1',
      pageHostGeneration: 1
    })
    for (const event of ['did-attach', 'dom-ready', 'did-finish-load', 'did-stop-loading']) {
      page.dispatchEvent(new Event(event))
    }
    await mounting
    // The page's earlier pane webview can still hold its id while it moves to This device.
    Object.defineProperty(mountPage('page-1'), 'getWebContentsId', { value: () => 7 })
    const terminal = focusTerminal()

    expect(beginAgentInputFocusGuard('page-1', 41, 'input-1')).toBe('ready')
    // A guest press focuses the webview despite its inert host in Chromium; happy-dom needs inert lifted.
    const host = page.parentElement
    if (!host) {
      throw new Error('the retained page has no host')
    }
    host.inert = false
    page.focus()
    host.inert = true
    expect(document.activeElement).toBe(page)
    endAgentInputFocusGuard('input-1')

    expect(document.activeElement).toBe(terminal)
  })
})
