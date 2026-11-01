// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FontAutocomplete } from './SettingsFormControls'
import { FONT_SUGGESTION_RENDER_LIMIT } from './settings-form-option-filter'

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
    // Query body because dropdown options portal outside the Settings section.
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

  it('requests installed suggestions only after the picker is used', async () => {
    const requestSuggestions = vi.fn()

    function Harness(): ReactNode {
      const [value, setValue] = useState('Geist')
      return (
        <FontAutocomplete
          value={value}
          suggestions={['Geist', 'JetBrains Mono']}
          onChange={setValue}
          onRequestSuggestions={requestSuggestions}
        />
      )
    }

    await act(async () => {
      root.render(<Harness />)
    })

    expect(requestSuggestions).not.toHaveBeenCalled()

    await act(async () => {
      getInput().focus()
    })

    expect(requestSuggestions).toHaveBeenCalledOnce()
  })

  it('searches suggestions past the previous 320 font cutoff', async () => {
    const suggestions = [
      ...Array.from({ length: 350 }, (_value, index) => `System Font ${index}`),
      'Zed Mono'
    ]

    function Harness(): ReactNode {
      const [value, setValue] = useState('System Font 0')
      return <FontAutocomplete value={value} suggestions={suggestions} onChange={setValue} />
    }

    await act(async () => {
      root.render(<Harness />)
    })

    const input = getInput()

    await act(async () => {
      input.focus()
    })
    expect(getOptionLabels()).toHaveLength(FONT_SUGGESTION_RENDER_LIMIT)
    expect(getOptionLabels()).not.toContain('Zed Mono')

    await typeIntoInput(input, 'Zed')

    expect(getOptionLabels()).toEqual(['Zed Mono'])
  })

  it('renders the selected late-list font even when the full list is capped', async () => {
    const suggestions = [
      ...Array.from({ length: FONT_SUGGESTION_RENDER_LIMIT + 30 }, (_value, index) => {
        return `System Font ${index}`
      }),
      'Zed Mono'
    ]

    function Harness(): ReactNode {
      const [value, setValue] = useState('Zed Mono')
      return <FontAutocomplete value={value} suggestions={suggestions} onChange={setValue} />
    }

    await act(async () => {
      root.render(<Harness />)
    })

    await act(async () => {
      getInput().focus()
    })

    expect(getOptionLabels()).toHaveLength(FONT_SUGGESTION_RENDER_LIMIT)
    expect(getOptionLabels().at(-1)).toBe('Zed Mono')
  })

  it('previews searches without saving, restores on Escape, and commits a manual name once', async () => {
    const change = vi.fn()
    const preview = vi.fn()
    await act(async () => {
      root.render(
        <FontAutocomplete
          value="Geist"
          suggestions={['Geist', 'Georgia']}
          onChange={change}
          onPreviewFontFamily={preview}
          commitMode="blur"
        />
      )
    })
    await act(async () => getInput().focus())
    await typeIntoInput(getInput(), 'Geor')
    expect(change).not.toHaveBeenCalled()
    expect(preview).toHaveBeenLastCalledWith('Georgia')
    await act(async () => {
      getInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(getInput().value).toBe('Geist')
    await act(async () => getInput().blur())
    expect(change).not.toHaveBeenCalled()
    await act(async () => getInput().focus())
    await typeIntoInput(getInput(), '  My Custom Font  ')
    expect(preview).toHaveBeenLastCalledWith('My Custom Font')
    await act(async () => {
      getInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      getInput().blur()
    })
    expect(change.mock.calls).toEqual([['My Custom Font']])
  })

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

  it('commits typed names on blur and offers an explicit inherited-font choice', async () => {
    const change = vi.fn()
    function Harness(): ReactNode {
      const [value, setValue] = useState('Georgia')
      return (
        <FontAutocomplete
          value={value}
          suggestions={['Geist', 'Georgia']}
          defaultOptionLabel="Same as IDE font"
          commitMode="blur"
          onChange={(font) => {
            change(font)
            setValue(font)
          }}
        />
      )
    }
    await act(async () => root.render(<Harness />))
    await act(async () => getInput().focus())
    expect(getOptionLabels()[0]).toBe('Same as IDE font')
    await typeIntoInput(getInput(), 'My Custom Font')
    await act(async () => getInput().blur())
    expect(change.mock.calls).toEqual([['My Custom Font']])
    await act(async () => getInput().focus())
    const inherited = document.querySelector<HTMLButtonElement>('[role="option"]')
    await act(async () => inherited?.click())
    expect(change.mock.calls).toEqual([['My Custom Font'], ['']])
    expect(getInput().value).toBe('')
  })

  it.each([{ suggestions: [] }, { suggestions: ['Geist', 'SF Mono'] }])(
    'preserves an unlisted saved font on focus and Enter with suggestions $suggestions',
    async ({ suggestions }) => {
      const change = vi.fn()
      const preview = vi.fn()
      await act(async () => {
        root.render(
          <FontAutocomplete
            value="Georgia"
            suggestions={suggestions}
            onChange={change}
            onPreviewFontFamily={preview}
            defaultOptionLabel="Same as IDE font"
            commitMode="blur"
          />
        )
      })
      await act(async () => getInput().focus())
      expect(preview).toHaveBeenLastCalledWith('Georgia')
      await act(async () => {
        getInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(getInput().value).toBe('Georgia')
      expect(change).not.toHaveBeenCalled()
      await act(async () => getInput().blur())
      expect(change).not.toHaveBeenCalled()
    }
  )

  it.each([
    { label: 'Same as IDE font', query: '  SAME AS IDE  ' },
    { label: 'IDEと同じフォント', query: '同じ' }
  ])('searches the inherited option by its label: $label', async ({ label, query }) => {
    const change = vi.fn()
    await act(async () => {
      root.render(
        <FontAutocomplete
          value="Georgia"
          suggestions={['Geist', 'Georgia']}
          onChange={change}
          defaultOptionLabel={label}
          commitMode="blur"
        />
      )
    })
    await act(async () => getInput().focus())
    await typeIntoInput(getInput(), query)
    expect(getOptionLabels()).toEqual([label])
    await act(async () => {
      getInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(change.mock.calls).toEqual([['']])
    expect(getInput().value).toBe('')
  })

  it('commits the inherited value when its full label is typed and blurred', async () => {
    const change = vi.fn()
    await act(async () => {
      root.render(
        <FontAutocomplete
          value="Georgia"
          suggestions={['Geist', 'Georgia']}
          onChange={change}
          defaultOptionLabel="Same as IDE font"
          commitMode="blur"
        />
      )
    })
    await act(async () => getInput().focus())
    await typeIntoInput(getInput(), '  same as IDE font  ')
    await act(async () => getInput().blur())
    expect(change.mock.calls).toEqual([['']])
    expect(getInput().value).toBe('')
  })

  it('disables the whole picker and discards an open draft without saving', async () => {
    const change = vi.fn()
    const renderPicker = (disabled: boolean) => (
      <FontAutocomplete
        value="Geist"
        suggestions={['Geist', 'Georgia']}
        onChange={change}
        disabled={disabled}
        commitMode="blur"
      />
    )
    await act(async () => root.render(renderPicker(false)))
    await act(async () => getInput().focus())
    await typeIntoInput(getInput(), 'Geor')
    await act(async () => root.render(renderPicker(true)))
    expect(getInput().disabled).toBe(true)
    expect(getInput().value).toBe('Geist')
    expect(getOptionLabels()).toEqual([])
    expect(change).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('button')].every((button) => button.disabled)).toBe(true)
  })
})
