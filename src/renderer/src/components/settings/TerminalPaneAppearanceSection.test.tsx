// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalPaneAppearanceSection } from './TerminalPaneAppearanceSection'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSection(
  headerButtons: GlobalSettings['terminalPaneHeaderButtons'],
  updateSettings: (updates: Partial<GlobalSettings>) => void
): void {
  const settings = { ...getDefaultSettings('/home/user'), terminalPaneHeaderButtons: headerButtons }
  act(() => {
    root.render(
      <TerminalPaneAppearanceSection settings={settings} updateSettings={updateSettings} />
    )
  })
}

function headerButtonsOption(label: string): HTMLButtonElement {
  const option = Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="Pane Header Buttons"] [role="radio"]'
    )
  ).find((candidate) => candidate.textContent === label)
  if (!option) {
    throw new Error(`header buttons option not found: ${label}`)
  }
  return option
}

describe('TerminalPaneAppearanceSection header buttons', () => {
  it('saves On Hover when it is picked', () => {
    const updateSettings = vi.fn()
    renderSection('always', updateSettings)

    expect(headerButtonsOption('When active or hovered').getAttribute('aria-checked')).toBe('true')
    act(() => headerButtonsOption('On hover or keyboard focus').click())

    expect(updateSettings).toHaveBeenCalledWith({ terminalPaneHeaderButtons: 'hover' })
  })

  it('shows the stored hover mode as selected', () => {
    renderSection('hover', vi.fn())

    expect(headerButtonsOption('On hover or keyboard focus').getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(headerButtonsOption('When active or hovered').getAttribute('aria-checked')).toBe('false')
  })
})
