import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { resolvePluginPanelIcon } from './plugin-panel-activity-items'

it('renders a served panel icon as a current-color mask', () => {
  const Icon = resolvePluginPanelIcon('orca-plugin-image://installed/acme.example/dev/panel-0')
  const html = renderToStaticMarkup(createElement(Icon, { size: 18 }))
  expect(html).toContain(
    'mask-image:url(&quot;orca-plugin-image://installed/acme.example/dev/panel-0&quot;)'
  )
  expect(html).toContain('background-color:currentColor')
})
