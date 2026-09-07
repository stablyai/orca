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

import { DiffShowWhitespaceSetting } from './DiffShowWhitespaceSetting'

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

function renderSetting(diffShowWhitespace: boolean, updateSettings = vi.fn()) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <DiffShowWhitespaceSetting
        settings={{ ...getDefaultSettings(join('test', 'home')), diffShowWhitespace }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

describe('DiffShowWhitespaceSetting', () => {
  it('defaults to off so whitespace-only diffs stay quiet', () => {
    const { container } = renderSetting(false)
    const off = [...container.querySelectorAll('[role="radio"]')].find(
      (button) => button.textContent === 'Off'
    )

    expect(off?.getAttribute('aria-checked')).toBe('true')
  })

  it('shows on when the preference is enabled', () => {
    const { container } = renderSetting(true)
    const on = [...container.querySelectorAll('[role="radio"]')].find(
      (button) => button.textContent === 'On'
    )

    expect(on?.getAttribute('aria-checked')).toBe('true')
  })

  it('persists the on choice', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting(false, updateSettings)
    const on = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === 'On'
    )

    act(() => on?.click())

    expect(updateSettings).toHaveBeenCalledWith({ diffShowWhitespace: true })
  })
})
