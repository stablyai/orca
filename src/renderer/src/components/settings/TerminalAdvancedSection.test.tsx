// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalAdvancedSection } from './TerminalAdvancedSection'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, defaultValue: string) => defaultValue
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

describe('TerminalAdvancedSection scrollback rows', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.replaceChildren()
  })

  function renderSection(updateSettings = vi.fn()): void {
    act(() => {
      root.render(
        <TerminalAdvancedSection
          settings={
            {
              terminalScrollbackRows: 5000,
              terminalScopeHistoryByWorktree: true
            } as GlobalSettings
          }
          updateSettings={updateSettings}
          scrollbackMode="custom"
          setScrollbackMode={vi.fn()}
          searchQuery=""
          showWindowsPowerShellImplementation={false}
          isMac={false}
        />
      )
    })
  }

  function getScrollbackRowsInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')
    if (!input) {
      throw new Error('scrollback rows input not found')
    }
    return input
  }

  function setNativeValue(input: HTMLInputElement, text: string): void {
    // Why: React reads controlled-input changes through the native value setter.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, text)
  }

  function typeText(input: HTMLInputElement, text: string): void {
    act(() => {
      setNativeValue(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function blurInput(input: HTMLInputElement): void {
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  function pressEnter(input: HTMLInputElement): void {
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }

  it('keeps custom row edits local until blur', () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)

    const input = getScrollbackRowsInput()
    typeText(input, '2')
    expect(input.value).toBe('2')
    typeText(input, '25')
    expect(input.value).toBe('25')
    expect(updateSettings).not.toHaveBeenCalled()

    blurInput(input)

    expect(updateSettings).toHaveBeenCalledWith({ terminalScrollbackRows: 1000 })
    expect(input.value).toBe('1000')
  })

  it('commits the normalized custom rows on Enter', () => {
    const updateSettings = vi.fn()
    renderSection(updateSettings)

    const input = getScrollbackRowsInput()
    typeText(input, '12345.9')
    pressEnter(input)

    expect(updateSettings).toHaveBeenCalledWith({ terminalScrollbackRows: 12345 })
    expect(input.value).toBe('12345')
  })

  it('keeps shell history as a row inside Advanced', () => {
    renderSection()

    const headings = Array.from(container.querySelectorAll('h3')).map(
      (heading) => heading.textContent
    )
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Scope shell history to each workspace"]'
    )

    expect(headings).toEqual(['Advanced'])
    expect(toggle?.closest('section')?.querySelector('h3')?.textContent).toBe('Advanced')
  })
})
