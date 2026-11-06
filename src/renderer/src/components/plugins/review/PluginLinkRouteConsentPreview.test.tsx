// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, describe, it } from 'vitest'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
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

  it('shows each hostname as the literal declared string', () => {
    const el = render([
      { hostname: '*.example.com', destination: 'orca-browser', description: 'Docs site' },
      { hostname: 'app-devserver.test', destination: 'system-browser' }
    ])

    const mono = [...el.querySelectorAll('.font-mono')].map((node) => node.textContent)
    expect(mono).toEqual(['*.example.com', 'app-devserver.test'])
  })

  it('warns only on the route that conflicts', () => {
    const el = render([
      { hostname: 'shared.example.com', destination: 'orca-browser', conflict: true },
      { hostname: 'own.example.com', destination: 'orca-browser' }
    ])

    expect(el.querySelectorAll('[data-link-route-conflict]')).toHaveLength(1)
  })
})
