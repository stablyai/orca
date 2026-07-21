// @vitest-environment happy-dom

import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

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

function renderSetting(
  editorKeybindings: GlobalSettings['editorKeybindings'],
  updateSettings = vi.fn()
) {
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

function radio(container: HTMLDivElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label
  )
}

describe('EditorKeybindingsSetting', () => {
  it('selects Default when keybindings are unset (legacy profiles)', () => {
    const { container } = renderSetting(undefined)
    expect(radio(container, 'Default')?.getAttribute('aria-checked')).toBe('true')
  })

  it('selects Vim when the preference is enabled', () => {
    const { container } = renderSetting('vim')
    expect(radio(container, 'Vim')?.getAttribute('aria-checked')).toBe('true')
  })

  it('persists the vim choice', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting('default', updateSettings)
    act(() => radio(container, 'Vim')?.click())
    expect(updateSettings).toHaveBeenCalledWith({ editorKeybindings: 'vim' })
  })

  it('persists switching back to standard editing', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting('vim', updateSettings)
    act(() => radio(container, 'Default')?.click())
    expect(updateSettings).toHaveBeenCalledWith({ editorKeybindings: 'default' })
  })
})
