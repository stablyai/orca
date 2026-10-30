// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  panels: [] as { tabKey: string }[]
}))

vi.mock('@/store/plugin-panels', () => ({
  useLeftNavigationPluginPanels: () => mocks.panels
}))

vi.mock('@/components/right-sidebar/PluginPanel', () => ({
  default: ({ tabKey }: { tabKey: string }) => <div data-panel-tab-key={tabKey} />
}))

import { PluginMainPage } from './PluginMainPage'

afterEach(() => {
  mocks.panels = []
  document.body.innerHTML = ''
})

describe('PluginMainPage', () => {
  it('mounts the selected sandboxed panel surface and removes it when the panel is disabled', async () => {
    const first = 'plugin:samples.one/dashboard'
    const second = 'plugin:samples.two/dashboard'
    mocks.panels = [{ tabKey: first }, { tabKey: second }]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(<PluginMainPage tabKey={second} />))
    expect(container.querySelectorAll('[data-panel-tab-key]')).toHaveLength(1)
    expect(
      container.querySelector('[data-panel-tab-key]')?.getAttribute('data-panel-tab-key')
    ).toBe(second)

    mocks.panels = [{ tabKey: first }]
    await act(async () => root.render(<PluginMainPage tabKey={second} />))
    expect(container.querySelector('[data-panel-tab-key]')).toBeNull()
    expect(container.textContent).toContain('no longer available')

    await act(async () => root.unmount())
  })
})
