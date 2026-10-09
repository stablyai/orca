// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { buildPluginPanelShellHtml, PLUGIN_PANEL_CSP } from './plugin-panel-shell'

describe('buildPluginPanelShellHtml', () => {
  it('places CSP and navigation guards before plugin content', () => {
    const html = buildPluginPanelShellHtml('<main id="plugin-content">Plugin</main>')
    const pluginOffset = html.indexOf('plugin-content')

    expect(PLUGIN_PANEL_CSP).toContain("form-action 'none'")
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(pluginOffset)
    expect(html.indexOf("window.navigation.addEventListener('navigate'")).toBeLessThan(pluginOffset)
    expect(html.indexOf("window.addEventListener('click'")).toBeLessThan(pluginOffset)
    expect(html.indexOf("window.addEventListener('submit'")).toBeLessThan(pluginOffset)
    expect(html.indexOf("Object.defineProperty(window, 'open'")).toBeLessThan(pluginOffset)
  })

  it('cancels anchor and form default navigation in the fallback path', () => {
    const html = buildPluginPanelShellHtml('<main>Plugin</main>')
    const script = html.match(/<script>\n([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    // Keep happy-dom's global removable for Vitest teardown; production shell
    // keeps the override non-configurable inside the disposable iframe.
    window.eval(script!.replace('configurable: false', 'configurable: true'))

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
})
