// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  buildPluginGuestShellHtml,
  buildPluginPanelShellHtml,
  PLUGIN_GUEST_CSP
} from './plugin-panel-shell'

describe('buildPluginPanelShellHtml', () => {
  it('removes WebRTC peer connections before plugin code can reach them', () => {
    const html = buildPluginPanelShellHtml('<main>Plugin</main>')
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
    Object.assign(window, { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {} })
    // Configurable only so happy-dom can tear down; the iframe copy stays locked.
    window.eval(script!.replaceAll('configurable: false', 'configurable: true'))

    expect(window.eval('typeof RTCPeerConnection')).toBe('undefined')
    expect(window.eval('typeof webkitRTCPeerConnection')).toBe('undefined')
    window.eval('RTCPeerConnection = function () {}')
    expect(window.eval('typeof RTCPeerConnection')).toBe('undefined')
  })

  it('cancels anchor and form default navigation in the fallback path', () => {
    const html = buildPluginPanelShellHtml('<main>Plugin</main>')
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    // Keep happy-dom's global removable for Vitest teardown; production shell
    // keeps the override non-configurable inside the disposable iframe.
    window.eval(script!.replaceAll('configurable: false', 'configurable: true'))

    const anchor = document.createElement('a')
    anchor.href = 'https://example.com/'
    document.body.appendChild(anchor)
    const clickAccepted = anchor.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    )
    const form = document.createElement('form')
    document.body.appendChild(form)
    const submitAccepted = form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )

    expect(clickAccepted).toBe(false)
    expect(submitAccepted).toBe(false)
    expect(window.open('https://example.com/')).toBeNull()
  })

  it('applies a theme message from the host in place, and only from the host', () => {
    const html = buildPluginPanelShellHtml('<main>Plugin</main>')
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
    window.eval(script!.replaceAll('configurable: false', 'configurable: true'))
    document.documentElement.className = 'light keep'
    const style = document.createElement('style')
    style.id = 'orca-design-tokens'
    style.textContent = ':root{--orca-background:white}'
    document.head.appendChild(style)
    const theme = {
      orca: 1,
      kind: 'evt',
      event: 'theme',
      payload: { colorScheme: 'dark', tokens: '--orca-background:black' }
    }

    window.dispatchEvent(new MessageEvent('message', { data: theme, source: null }))
    expect(document.documentElement.className).toBe('light keep')

    window.dispatchEvent(new MessageEvent('message', { data: theme, source: window.parent }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('keep')).toBe(true)
    expect(style.textContent).toBe(':root{--orca-background:black}')

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...theme, payload: { ...theme.payload, tokens: '}</style><script>x</script>{' } },
        source: window.parent
      })
    )
    expect(style.textContent).toBe(':root{/stylescriptx/script}')
    style.remove()
  })
})

describe('buildPluginGuestShellHtml', () => {
  it('injects only the frame API ahead of plugin HTML; main fences the guest', () => {
    const html = buildPluginGuestShellHtml('<main>Plugin</main>')
    expect(html.indexOf('__orcaPluginFrameTransport')).toBeLessThan(html.indexOf('<main>'))
    expect(html).toContain('<style id="orca-design-tokens">')
    expect(html).not.toContain('Content-Security-Policy')
    expect(html).not.toContain('RTCPeerConnection')
    expect(html).not.toContain('__ORCA_PANEL_TOKENS__')
  })

  it('pins the guest CSP from the design contract', () => {
    expect(PLUGIN_GUEST_CSP).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
        "media-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; " +
        "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
  })

  it("hands Orca's declarative boot script a post hook only on its own page", () => {
    expect(buildPluginGuestShellHtml('<main></main>')).not.toContain('__orcaDeclarativePost')
    expect(buildPluginGuestShellHtml('<main></main>', 'panel', { declarative: true })).toContain(
      '"declarativePost":"__orcaDeclarativePost"'
    )
  })

  it("never puts shell or files on a components panel's hidden guest", () => {
    expect(buildPluginGuestShellHtml('<main></main>')).toContain('"user":{')
    expect(buildPluginGuestShellHtml('<main></main>', 'panel', { declarative: true })).toContain(
      '"user":null'
    )
  })

  it('offers user-gesture methods to guests only, where Orca can verify the gesture', () => {
    const methods = (html: string) => html.match(/"methods":(\[[^\]]*\])/)?.[1] ?? ''
    expect(methods(buildPluginPanelShellHtml('<main></main>'))).not.toContain('shell.openExternal')
    expect(methods(buildPluginGuestShellHtml('<main></main>'))).toContain('shell.openExternal')
    expect(methods(buildPluginGuestShellHtml('<main></main>'))).toContain('notifications.show')
  })

  it('paints the host theme before any script, so boot-time token reads get values', () => {
    const html = buildPluginGuestShellHtml('<main></main>', 'panel', {
      theme: { colorScheme: 'dark', tokens: '--orca-background:#000;}</style><script>x' }
    })
    expect(html).toMatch(/^<!doctype html>\n<html class="dark">/)
    expect(html).toContain(
      '<style id="orca-design-tokens">:root{--orca-background:#000;/stylescriptx}</style>'
    )
    expect(html.indexOf('orca-design-tokens')).toBeLessThan(html.indexOf('<script>'))
    expect(buildPluginGuestShellHtml('<main></main>')).toContain('<html>\n')
  })
})
