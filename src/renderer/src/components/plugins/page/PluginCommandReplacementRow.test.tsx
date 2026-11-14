// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { PluginCommandReplacementRow } from './PluginCommandReplacementRow'

let root: Root
let container: HTMLDivElement
const updateSettings = vi.fn(async () => undefined)
const initial = useAppStore.getState()

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  updateSettings.mockClear()
  const patch = {
    updateSettings,
    settings: { ...initial.settings, pluginReplacementsOff: ['sidebar.left.toggle'] }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only settings and updateSettings.
  useAppStore.setState(patch as never)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
})

describe('a replacing command on the plugin page', () => {
  it('names the action it replaces and keeps Orca’s own when switched off', async () => {
    await act(async () =>
      root.render(
        <PluginCommandReplacementRow command={{ title: 'Board', replaces: 'view.tasks' }} />
      )
    )
    expect(container.textContent).toContain('Board runs instead of Orca’s')
    const toggle = container.querySelector('button[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    await act(async () => (toggle instanceof HTMLElement ? toggle.click() : undefined))
    expect(updateSettings).toHaveBeenCalledWith({
      pluginReplacementsOff: ['sidebar.left.toggle', 'view.tasks']
    })
  })

  it('shows a lost conflict instead of a switch', async () => {
    await act(async () =>
      root.render(
        <PluginCommandReplacementRow
          command={{ title: 'Board', replaces: 'view.tasks', replacedBy: 'acme.first' }}
        />
      )
    )
    expect(container.textContent).toContain('Not used: acme.first, installed first, replaces it')
    expect(container.querySelector('button[role="switch"]')).toBeNull()
  })
})
