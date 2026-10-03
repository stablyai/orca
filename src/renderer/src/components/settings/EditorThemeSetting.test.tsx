// @vitest-environment happy-dom

import { join } from 'node:path'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('../ui/select', async () => {
  const ReactModule = await import('react')
  const { ALL_EDITOR_THEMES } = await import('@/lib/monaco-themes')
  const SelectContext = ReactModule.createContext<{
    value?: string
    onValueChange?: (value: string) => void
  }>({})

  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = ReactModule.useMemo(
        () => ({ value, onValueChange }),
        [value, onValueChange]
      )
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="select" data-value={value}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button type="button" role="combobox" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => {
      const { value } = ReactModule.useContext(SelectContext)
      const label = ALL_EDITOR_THEMES.find((theme) => theme.id === value)?.name ?? value
      return <span data-slot="select-value">{label}</span>
    },
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = ReactModule.useContext(SelectContext)
      return (
        <button
          type="button"
          role="option"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

import { EditorThemeSetting } from './EditorThemeSetting'

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
  props: { editorThemeDark?: string; editorThemeLight?: string } = {},
  updateSettings = vi.fn()
) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <EditorThemeSetting
        settings={{
          ...getDefaultSettings(join('test', 'home')),
          ...props
        }}
        updateSettings={updateSettings}
      />
    )
  })
  return { container, updateSettings }
}

describe('EditorThemeSetting', () => {
  it('renders dark and light theme selectors', () => {
    const { container } = renderSetting()
    const triggers = container.querySelectorAll('[role="combobox"]')
    expect(triggers.length).toBe(2)

    expect(triggers[0]?.getAttribute('aria-label')).toBe('Editor Theme (Dark Mode)')
    expect(triggers[1]?.getAttribute('aria-label')).toBe('Editor Theme (Light Mode)')
  })

  it('displays configured dark and light theme values and visible labels', () => {
    const { container } = renderSetting({
      editorThemeDark: 'dracula',
      editorThemeLight: 'one-light'
    })
    const selects = container.querySelectorAll('[data-slot="select"]')
    expect(selects[0]?.getAttribute('data-value')).toBe('dracula')
    expect(selects[1]?.getAttribute('data-value')).toBe('one-light')

    const triggers = container.querySelectorAll('[role="combobox"]')
    expect(triggers[0]?.textContent).toContain('Dracula')
    expect(triggers[1]?.textContent).toContain('One Light')
  })

  it('updates dark editor theme when a dark theme is selected', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting({}, updateSettings)
    const draculaOption = container.querySelector<HTMLButtonElement>(
      'button[role="option"][data-value="dracula"]'
    )
    expect(draculaOption).not.toBeNull()

    act(() => draculaOption?.click())
    expect(updateSettings).toHaveBeenCalledWith({ editorThemeDark: 'dracula' })
  })

  it('updates light editor theme when a light theme is selected', () => {
    const updateSettings = vi.fn()
    const { container } = renderSetting({}, updateSettings)
    const oneLightOption = container.querySelector<HTMLButtonElement>(
      'button[role="option"][data-value="one-light"]'
    )
    expect(oneLightOption).not.toBeNull()

    act(() => oneLightOption?.click())
    expect(updateSettings).toHaveBeenCalledWith({ editorThemeLight: 'one-light' })
  })
})
