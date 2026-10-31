// @vitest-environment happy-dom

import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { TiledAgentsExperimentalSetting } from './TiledAgentsExperimentalSetting'
import { getExperimentalPaneSearchEntries } from './experimental-search'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('TiledAgentsExperimentalSetting', () => {
  it('renders tiled agents as an off-by-default searchable experiment', () => {
    const settings = getDefaultSettings('/tmp')
    const markup = renderToStaticMarkup(
      <TiledAgentsExperimentalSetting settings={settings} updateSettings={vi.fn()} />
    )
    const searchEntry = getExperimentalPaneSearchEntries().find(
      (entry) => entry.title === 'Tiled agents'
    )

    expect(settings.experimentalTiledAgents).toBeUndefined()
    expect(markup).toContain('Tiled agents')
    expect(markup).toContain('Up to nine agents as cards at once')
    expect(searchEntry?.keywords).toEqual(expect.arrayContaining(['tile', 'grid']))
  })

  it('enables tiled agents through its experimental switch', async () => {
    const updateSettings = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <TiledAgentsExperimentalSetting
          settings={getDefaultSettings('/tmp')}
          updateSettings={updateSettings}
        />
      )
    })
    const switchButton = container.querySelector<HTMLButtonElement>(
      '#experimental-tiled-agents button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Tiled agents switch was not rendered')
    }

    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ experimentalTiledAgents: true })
    root.unmount()
  })
})
