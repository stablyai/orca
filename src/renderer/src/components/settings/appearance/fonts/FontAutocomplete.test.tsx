// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FontAutocomplete } from './FontAutocomplete'

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

  async function typeIntoInput(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      // Use the native setter so React’s controlled-input tracker recognizes the synthetic event.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function pressInputKey(
    input: HTMLInputElement,
    key: string,
    options?: { isComposing?: boolean }
  ): Promise<void> {
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true })
      if (options?.isComposing !== undefined) {
        Object.defineProperty(event, 'isComposing', { value: options.isComposing })
      }
      input.dispatchEvent(event)
    })
  }

  it.each([
    { query: 'Geor', description: 'a highlighted suggestion' },
    { query: 'My Custom Font', description: 'a manual font name' }
  ])('does not commit $description when Enter confirms IME composition', async ({ query }) => {
    const change = vi.fn()
    await act(async () => {
      root.render(
        <FontAutocomplete
          value="Geist"
          suggestions={['Geist', 'Georgia']}
          onChange={change}
          commitMode="blur"
        />
      )
    })
    const input = getInput()
    await act(async () => input.focus())
    await typeIntoInput(input, query)

    await pressInputKey(input, 'Enter', { isComposing: true })

    expect(input.value).toBe(query)
    expect(change).not.toHaveBeenCalled()
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })
})
