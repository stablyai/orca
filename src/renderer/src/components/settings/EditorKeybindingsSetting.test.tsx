// @vitest-environment happy-dom

import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

import { EditorKeybindingsSetting } from './EditorKeybindingsSetting'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

function renderSetting(editorKeybindings: 'default' | 'vim' | undefined, updateSettings = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <EditorKeybindingsSetting
        settings={{ ...getDefaultSettings(join('test', 'home')), editorKeybindings }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

function radio(name: string): HTMLButtonElement | undefined {
  return [...(container?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
    (button) => button.textContent === name
  )
}

describe('EditorKeybindingsSetting', () => {
  it('shows Default when the preference was never saved', () => {
    const { container: rendered } = renderSetting(undefined)
    const selected = [...rendered.querySelectorAll('[role="radio"]')].find(
      (button) => button.textContent === 'Default'
    )

    expect(selected?.getAttribute('aria-checked')).toBe('true')
  })

  it('persists Vim', () => {
    const updateSettings = vi.fn()
    renderSetting('default', updateSettings)

    act(() => radio('Vim')?.click())

    expect(updateSettings).toHaveBeenCalledWith({ editorKeybindings: 'vim' })
  })

  it('persists an explicit Default', () => {
    const updateSettings = vi.fn()
    renderSetting('vim', updateSettings)

    act(() => radio('Default')?.click())

    expect(updateSettings).toHaveBeenCalledWith({ editorKeybindings: 'default' })
  })
})
