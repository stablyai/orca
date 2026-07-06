// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FontAutocomplete } from './SettingsFormControls'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

describe('FontAutocomplete', () => {
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

  function getInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')
    if (!input) {
      throw new Error('Font autocomplete input not found')
    }
    return input
  }

  function getOptionLabels(): string[] {
    // Why: the dropdown portals to document.body so it can escape the settings
    // section; options are intentionally not descendants of the container.
    return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
      (option) => option.textContent?.trim() ?? ''
    )
  }

  function expectOptionsToBePortaled(): void {
    expect(container.querySelector('[role="option"]')).toBeNull()
  }

  function getScrollArea(): HTMLElement {
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="scroll-area"]')
    if (!scrollArea) {
      throw new Error('Font autocomplete scroll area not found')
    }
    return scrollArea
  }

  function getScrollAreaViewport(): HTMLElement {
    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!viewport) {
      throw new Error('Font autocomplete scroll area viewport not found')
    }
    return viewport
  }

  async function typeIntoInput(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      // Why: React tracks controlled input values through the native setter, so
      // direct assignment can be ignored by the synthetic input event.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('arrow keys move through the full list when the input shows the committed font', async () => {
    function Harness(): ReactNode {
      const [value, setValue] = useState('Geist')
      return (
        <FontAutocomplete
          value={value}
          suggestions={['Arial', 'Courier New', 'Geist', 'JetBrains Mono', 'SF Mono']}
          onChange={setValue}
        />
      )
    }

    await act(async () => {
      root.render(<Harness />)
    })

    const input = getInput()

    await act(async () => {
      input.focus()
    })

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(
      document
        .querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
        ?.textContent?.trim()
    ).toBe('JetBrains Mono')
    expectOptionsToBePortaled()
  })

  it('shows the full list on focus when the committed font has multiple matching suggestions', async () => {
    function Harness(): ReactNode {
      const [value, setValue] = useState('Cascadia Mono')
      return (
        <FontAutocomplete
          value={value}
          suggestions={['Arial', 'Cascadia Code', 'Cascadia Mono', 'Cascadia Mono PL', 'Consolas']}
          onChange={setValue}
        />
      )
    }

    await act(async () => {
      root.render(<Harness />)
    })

    await act(async () => {
      getInput().focus()
    })

    expect(getOptionLabels()).toEqual([
      'Arial',
      'Cascadia Code',
      'Cascadia Mono',
      'Cascadia Mono PL',
      'Consolas'
    ])
    expectOptionsToBePortaled()
  })

  it('bounds the portaled list to the available popover height', async () => {
    function Harness(): ReactNode {
      const [value, setValue] = useState('Cascadia Mono')
      return (
        <FontAutocomplete
          value={value}
          suggestions={['Arial', 'Cascadia Code', 'Cascadia Mono', 'Cascadia Mono PL', 'Consolas']}
          onChange={setValue}
        />
      )
    }

    await act(async () => {
      root.render(<Harness />)
    })

    await act(async () => {
      getInput().focus()
    })

    expect(getScrollArea().style.maxHeight).toBe('var(--radix-popover-content-available-height)')
    expect(getScrollAreaViewport().style.maxHeight).toBe(
      'var(--radix-popover-content-available-height)'
    )
  })

  it('keeps typed searches filtered even after the value updates', async () => {
    function Harness(): ReactNode {
      const [value, setValue] = useState('Geist')
      return (
        <FontAutocomplete
          value={value}
          suggestions={['Arial', 'Courier New', 'Geist', 'JetBrains Mono', 'SF Mono']}
          onChange={setValue}
        />
      )
    }

    await act(async () => {
      root.render(<Harness />)
    })

    const input = getInput()

    await act(async () => {
      input.focus()
    })
    await typeIntoInput(input, 'Jet')

    expect(getOptionLabels()).toEqual(['JetBrains Mono'])
  })
})
