// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => {
  const panels: { tabKey: string; title: string; pluginName: string }[] = []
  return { panels }
})

vi.mock('@/store/plugin-panels', () => ({
  useLeftNavigationPluginPanels: () => mocks.panels
}))

vi.mock('@/components/right-sidebar/PluginPanel', () => ({
  default: ({ tabKey }: { tabKey: string }) => <div data-panel-tab-key={tabKey} />
}))

import { PluginMainPage } from './PluginMainPage'

afterEach(() => {
  mocks.panels = []
  useAppStore.setState({ activeView: 'terminal' })
  document.body.innerHTML = ''
})

describe('PluginMainPage', () => {
  it('mounts the selected sandboxed panel surface and removes it when the panel is disabled', async () => {
    const first = 'plugin:samples.one/dashboard'
    const second = 'plugin:samples.two/dashboard'
    mocks.panels = [
      { tabKey: first, title: 'Overview', pluginName: 'Samples One' },
      { tabKey: second, title: 'Dashboard', pluginName: 'Samples Two' }
    ]
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(<PluginMainPage tabKey={second} />))
    expect(container.querySelectorAll('[data-panel-tab-key]')).toHaveLength(1)
    expect(
      container.querySelector('[data-panel-tab-key]')?.getAttribute('data-panel-tab-key')
    ).toBe(second)

    mocks.panels = [{ tabKey: first, title: 'Overview', pluginName: 'Samples One' }]
    await act(async () => root.render(<PluginMainPage tabKey={second} />))
    expect(container.querySelector('[data-panel-tab-key]')).toBeNull()
    expect(container.textContent).toContain('no longer available')

    await act(async () => root.unmount())
  })

  it('shows plugin provenance and closes an available or unavailable page to the workspace', async () => {
    const tabKey = 'plugin:samples.two/dashboard'
    mocks.panels = [{ tabKey, title: 'Dashboard', pluginName: 'Samples Two' }]
    useAppStore.setState({
      activeView: tabKey,
      worktreeNavHistory: [],
      worktreeNavHistoryIndex: -1
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(<PluginMainPage tabKey={tabKey} />))
    expect(container.querySelector('h1')?.textContent).toBe('Dashboard')
    expect(container.textContent).toContain('Samples Two')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close plugin page"]')?.click()
    })
    expect(useAppStore.getState().activeView).toBe('terminal')

    mocks.panels = []
    useAppStore.setState({ activeView: tabKey })
    await act(async () => root.render(<PluginMainPage tabKey={tabKey} />))
    expect(container.textContent).toContain('no longer available')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Close plugin page"]')?.click()
    })
    expect(useAppStore.getState().activeView).toBe('terminal')
    await act(async () => root.unmount())
  })
})
