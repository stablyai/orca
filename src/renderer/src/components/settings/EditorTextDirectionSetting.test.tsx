// @vitest-environment happy-dom

import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { EditorTextDirection } from '../../../../shared/editor-text-direction'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

import { EditorTextDirectionSetting } from './EditorTextDirectionSetting'

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
  editorTextDirection: EditorTextDirection | undefined,
  updateSettings = vi.fn()
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <EditorTextDirectionSetting
        settings={{ ...getDefaultSettings(join('test', 'home')), editorTextDirection }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

function option(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label
  )
}

describe('EditorTextDirectionSetting', () => {
  it('shows LTR for profiles saved before the preference existed', () => {
    const { container } = renderSetting(undefined)

    expect(option(container, 'LTR')?.getAttribute('aria-checked')).toBe('true')
  })

  it('falls back to LTR rather than rendering a corrupted persisted value', () => {
    const { container } = renderSetting('sideways' as EditorTextDirection)

    expect(option(container, 'LTR')?.getAttribute('aria-checked')).toBe('true')
  })

  it('reflects the persisted auto choice', () => {
    expect(option(renderSetting('auto').container, 'Auto')?.getAttribute('aria-checked')).toBe(
      'true'
    )
  })

  it('reflects the persisted rtl choice', () => {
    expect(option(renderSetting('rtl').container, 'RTL')?.getAttribute('aria-checked')).toBe('true')
  })

  it('persists each direction choice', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting('ltr', updateSettings)

    act(() => option(container, 'RTL')?.click())
    expect(updateSettings).toHaveBeenCalledWith({ editorTextDirection: 'rtl' })

    act(() => option(container, 'Auto')?.click())
    expect(updateSettings).toHaveBeenCalledWith({ editorTextDirection: 'auto' })
  })
})
