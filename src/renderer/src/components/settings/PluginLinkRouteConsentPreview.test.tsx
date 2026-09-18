// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, describe, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { PluginLinkRouteConsentPreview } from './PluginLinkRouteConsentPreview'

type LinkRoutePreview = NonNullable<PluginHostListEntry['linkRoutes']>[number]

let container: HTMLDivElement | null = null

function render(routes: readonly LinkRoutePreview[]): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PluginLinkRouteConsentPreview routes={routes} />)
  })
  return container
}

afterEach(() => {
  container?.remove()
  container = null
})

describe('PluginLinkRouteConsentPreview', () => {
  it('renders nothing when the plugin declares no routes', () => {
    expect(render([]).innerHTML).toBe('')
  })

  it('shows each hostname as a literal string with its destination', () => {
    const el = render([
      { hostname: '*.example.com', destination: 'orca-browser', description: 'Docs site' },
      { hostname: 'app-devserver.test', destination: 'system-browser' }
    ])

    const mono = [...el.querySelectorAll('.font-mono')].map((node) => node.textContent)
    expect(mono).toEqual(['*.example.com', 'app-devserver.test'])
    expect(el.textContent).toContain("Opens in Orca's built-in browser")
    expect(el.textContent).toContain('Opens in your system browser')
    expect(el.textContent).toContain('Docs site')
  })

  it('warns that a conflicting route is inactive without echoing the main-process string', () => {
    const el = render([
      {
        hostname: 'example.com',
        destination: 'orca-browser',
        conflict: true
      }
    ])

    expect(el.textContent).toContain('stays inactive')
    expect(el.textContent).not.toContain('also contributed by another plugin')
  })
})
