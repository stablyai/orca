// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { TerminalRichInputSlashMenu } from './TerminalRichInputSlashMenu'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('TerminalRichInputSlashMenu', () => {
  it('never returns scrollIntoView as a React effect cleanup', async () => {
    const scrollIntoView = vi.fn(() => false)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <TerminalRichInputSlashMenu
          id="slash-menu"
          suggestions={[{ name: 'clear', description: 'Clear conversation' }]}
          activeIndex={0}
          onChoose={() => {}}
        />
      )
    })
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="listbox"]')?.id).toBe('slash-menu')
    expect(container.querySelector('[role="option"]')?.id).toBe('slash-menu-option-0')
    expect(container.querySelector('[role="option"]')?.getAttribute('aria-selected')).toBe('true')

    expect(() => {
      act(() => root.unmount())
    }).not.toThrow()
  })
})
