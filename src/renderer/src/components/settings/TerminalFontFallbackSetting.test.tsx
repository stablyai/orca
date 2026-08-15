// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { TerminalFontFallbackSetting } from './TerminalFontFallbackSetting'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, defaultValue: string) => defaultValue
}))

describe('TerminalFontFallbackSetting', () => {
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

  async function setInput(input: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function Harness(): React.JSX.Element {
    const [value, setValue] = useState<string[]>([])
    return (
      <TooltipProvider>
        <TerminalFontFallbackSetting
          value={value}
          suggestions={['Microsoft YaHei UI', 'Noto Sans Arabic']}
          onChange={setValue}
        />
      </TooltipProvider>
    )
  }

  it('adds, reorders, and removes fallback fonts', async () => {
    await act(async () => root.render(<Harness />))

    await setInput(container.querySelector('input')!, 'Microsoft YaHei UI')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button:not([aria-label])')!.click()
    )

    await setInput(container.querySelectorAll('input')[1]!, 'Noto Sans Arabic')
    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button:not([aria-label])'))
        .at(-1)!
        .click()
    )

    expect(
      Array.from(container.querySelectorAll('ol input')).map(
        (input) => (input as HTMLInputElement).value
      )
    ).toEqual(['Microsoft YaHei UI', 'Noto Sans Arabic'])

    await act(async () =>
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Move up"]')[1]!.click()
    )
    expect(
      Array.from(container.querySelectorAll('ol input')).map(
        (input) => (input as HTMLInputElement).value
      )
    ).toEqual(['Noto Sans Arabic', 'Microsoft YaHei UI'])

    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>('button[aria-label="Remove fallback"]')[0]!
        .click()
    )
    expect(container.querySelectorAll('ol input')).toHaveLength(1)
  })

  it('keeps focus and the row while editing, and rejects an empty commit', async () => {
    await act(async () => root.render(<Harness />))

    await setInput(container.querySelector('input')!, 'Microsoft YaHei UI')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button:not([aria-label])')!.click()
    )

    const rowInput = container.querySelector<HTMLInputElement>('ol input')!
    await act(async () => rowInput.focus())
    await setInput(rowInput, 'Noto Sans')
    expect(document.activeElement).toBe(rowInput)
    expect(container.querySelectorAll('ol input')).toHaveLength(1)

    await act(async () => container.querySelectorAll<HTMLInputElement>('input')[1]!.focus())
    expect(container.querySelector<HTMLInputElement>('ol input')?.value).toBe('Noto Sans')

    const editedInput = container.querySelector<HTMLInputElement>('ol input')!
    await act(async () => editedInput.focus())
    await setInput(editedInput, '')
    await act(async () => container.querySelectorAll<HTMLInputElement>('input')[1]!.focus())

    expect(container.querySelectorAll('ol input')).toHaveLength(1)
    expect(container.querySelector<HTMLInputElement>('ol input')?.value).toBe('Noto Sans')
  })

  it('shows and enforces the configured stack limit', async () => {
    const fonts = Array.from({ length: 32 }, (_, index) => `Font ${index}`)
    await act(async () =>
      root.render(
        <TooltipProvider>
          <TerminalFontFallbackSetting value={fonts} suggestions={[]} onChange={vi.fn()} />
        </TooltipProvider>
      )
    )

    await setInput(container.querySelectorAll<HTMLInputElement>('input')[32]!, 'One more font')

    expect(container.textContent).toContain('Maximum of 32 fallback fonts reached.')
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button:not([aria-label])')).at(-1)
        ?.disabled
    ).toBe(true)
  })

  it('prevents adding the same family twice with different casing', async () => {
    await act(async () => root.render(<Harness />))

    await setInput(container.querySelector('input')!, 'Microsoft YaHei UI')
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button:not([aria-label])')!.click()
    )
    await setInput(container.querySelectorAll('input')[1]!, 'microsoft yahei ui')

    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button:not([aria-label])')).at(-1)
        ?.disabled
    ).toBe(true)
  })
})
