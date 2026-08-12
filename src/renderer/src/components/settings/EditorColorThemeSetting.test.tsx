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

import { EditorColorThemeSetting } from './EditorColorThemeSetting'

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
  editorColorTheme: 'auto' | 'vs' | 'vs-dark' | 'monokai' | undefined,
  updateSettings = vi.fn()
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <EditorColorThemeSetting
        settings={{ ...getDefaultSettings(join('test', 'home')), editorColorTheme }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

function findRadio(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label
  )
}

describe('EditorColorThemeSetting', () => {
  it('defaults to "Follow app theme" for profiles saved before the preference existed', () => {
    const { container } = renderSetting(undefined)

    expect(findRadio(container, 'Follow app theme')?.getAttribute('aria-checked')).toBe('true')
  })

  it('reflects an explicit Monokai selection', () => {
    const { container } = renderSetting('monokai')

    expect(findRadio(container, 'Monokai')?.getAttribute('aria-checked')).toBe('true')
  })

  it('persists a Monokai selection', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting('auto', updateSettings)

    act(() => findRadio(container, 'Monokai')?.click())

    expect(updateSettings).toHaveBeenCalledWith({ editorColorTheme: 'monokai' })
  })

  it('persists reverting back to "Follow app theme"', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting('monokai', updateSettings)

    act(() => findRadio(container, 'Follow app theme')?.click())

    expect(updateSettings).toHaveBeenCalledWith({ editorColorTheme: 'auto' })
  })
})
