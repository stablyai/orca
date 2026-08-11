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

import { EditorWordWrapSetting } from './EditorWordWrapSetting'

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

function renderSetting(editorWordWrap: boolean | undefined, updateSettings = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <EditorWordWrapSetting
        settings={{ ...getDefaultSettings(join('test', 'home')), editorWordWrap }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

describe('EditorWordWrapSetting', () => {
  it('shows wrapping as on for profiles saved before the preference existed', () => {
    const { container } = renderSetting(undefined)
    const on = [...container.querySelectorAll('[role="radio"]')].find(
      (button) => button.textContent === 'On'
    )

    expect(on?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows wrapping as off when the preference is disabled', () => {
    const { container } = renderSetting(false)
    const off = [...container.querySelectorAll('[role="radio"]')].find(
      (button) => button.textContent === 'Off'
    )

    expect(off?.getAttribute('aria-checked')).toBe('true')
  })

  it('persists the off choice for horizontal scrolling', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(true, updateSettings)
    const off = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === 'Off'
    )

    act(() => off?.click())

    expect(updateSettings).toHaveBeenCalledWith({ editorWordWrap: false })
  })

  it('persists the on choice without changing the diff preference', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(false, updateSettings)
    const on = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === 'On'
    )

    act(() => on?.click())

    expect(updateSettings).toHaveBeenCalledWith({ editorWordWrap: true })
  })
})
