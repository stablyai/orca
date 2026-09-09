// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  callback: null as ((event: MouseEvent, uri: string) => void) | null
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(callback: (event: MouseEvent, uri: string) => void) {
      harness.callback = callback
    }
  }
}))

vi.mock('@/lib/pane-manager/terminal-link-provider-guard', () => ({
  installGuardedLinkProviderRegistration: vi.fn()
}))

import { installPreviewTerminalLinks } from './preview-terminal-links'

describe('preview terminal links', () => {
  afterEach(() => {
    harness.callback = null
    vi.restoreAllMocks()
  })

  it('opens an HTTP link from a direct click', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { shell: { openUrl } } })
    const terminal = { loadAddon: vi.fn(), clearSelection: vi.fn() }

    installPreviewTerminalLinks(terminal as never)
    const event = new MouseEvent('click', { button: 0, cancelable: true })
    harness.callback?.(event, 'https://example.com/docs')

    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
    expect(terminal.clearSelection).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(true)
  })
})
