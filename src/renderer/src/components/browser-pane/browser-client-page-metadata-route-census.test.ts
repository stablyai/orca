import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Page metadata has exactly one way out of this renderer: main, which owns the browser-host lease.
 *
 * Why a census and not a behavioural test: the failure this guards is silent. The runtime accepts
 * page traffic only on the connection its lease attached on, so a publish sent as an ordinary
 * runtime call is refused as a stale lease and simply never lands — the pane keeps working, the
 * guest keeps navigating, and only the runtime's copy of the URL stays frozen at the create URL.
 * Nothing in the rendered result changes, so only the route itself can be asserted.
 */
const ROUTE_PATH = fileURLToPath(
  new URL('./browser-client-page-metadata-reporting.ts', import.meta.url)
)
const PANE_PATH = fileURLToPath(new URL('./ClientHostedBrowserPagePane.tsx', import.meta.url))

describe('client-hosted page metadata route', () => {
  const route = readFileSync(ROUTE_PATH, 'utf8')
  const pane = readFileSync(PANE_PATH, 'utf8')

  it('publishes through main and never through a plain runtime call', () => {
    expect(occurrences(route, 'window.api.browser.publishClientPageMetadata')).toBe(1)
    expect(occurrences(route, 'runtimeEnvironments.call')).toBe(0)
    expect(occurrences(pane, 'runtimeEnvironments.call')).toBe(0)
  })

  it('reports a publish that did not land', () => {
    expect(occurrences(route, 'onUnpublished:')).toBe(1)
  })

  // The pane must not build its own publisher around the route: a second construction site is a
  // second chance to wire the transport wrongly, and it would not be covered by the counts above.
  it('leaves the pane one way to start publishing', () => {
    expect(occurrences(pane, 'createBrowserClientPageMetadataPublisher(')).toBe(0)
    expect(occurrences(pane, 'startBrowserClientPageMetadataPublisher(')).toBe(1)
  })
})

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}
