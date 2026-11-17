// @vitest-environment happy-dom

import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { resolvePluginPanelIcon } from './plugin-panel-activity-items'

afterEach(cleanup)

it('shows a plug when the SVG cannot be loaded', () => {
  const Icon = resolvePluginPanelIcon('orca-plugin-image://installed/acme.example/dev/panel-0')
  const { container } = render(createElement(Icon, { size: 18 }))
  const probe = container.querySelector('img')
  expect(probe).not.toBeNull()
  if (!probe) {
    throw new Error('expected an image probe')
  }
  fireEvent.error(probe)
  expect(container.querySelector('svg')).not.toBeNull()
})
