// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildPluginPanelShellHtml } from './plugin-panel-shell'

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
