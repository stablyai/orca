// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { AgentIcon } from './agent-catalog'

afterEach(() => {
  usePluginIconThemeStore.setState({
    themes: [],
    activeId: null,
    activeTheme: null,
    loaded: true
  })
  document.body.innerHTML = ''
})

describe('AgentIcon plugin theme slots', () => {
  it('uses agent-specific slots and falls back to the plugin default slot', async () => {
    const codexIcon = 'data:image/svg+xml;base64,Y29kZXg='
    const defaultIcon = 'data:image/svg+xml;base64,ZGVmYXVsdA=='
    const activeTheme = {
      id: 'plugin:acme.icons/main' as const,
      pluginKey: 'acme.icons',
      label: 'Acme',
      icons: {
        'agent.codex': { dataUrl: codexIcon, rendering: 'image' as const },
        'agent.default': { dataUrl: defaultIcon, rendering: 'image' as const }
      },
      fileNames: {},
      fileExtensions: {}
    }
    usePluginIconThemeStore.setState({
      activeId: 'plugin:acme.icons/main',
      activeTheme,
      loaded: true,
      themes: [activeTheme]
    })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(<AgentIcon agent="codex" />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(codexIcon)

    await act(async () => root.render(<AgentIcon agent="opencode" />))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(defaultIcon)
    await act(async () => root.unmount())
  })
})
