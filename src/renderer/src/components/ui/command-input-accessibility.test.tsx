// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Command, CommandInput } from './command'

it('only announces placeholder hints that add to the accessible name', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const renderInput = async (label: string, placeholder: string): Promise<HTMLInputElement> => {
    await act(async () => {
      root.render(
        <Command>
          <CommandInput aria-label={label} placeholder={placeholder} value="" truncatePlaceholder />
        </Command>
      )
    })
    return container.querySelector('input')!
  }
  try {
    for (const [label, placeholder] of [
      ['Find results', 'Find results...'],
      ['Find results', 'Find results…']
    ]) {
      const input = await renderInput(label, placeholder)
      expect(input.getAttribute('aria-placeholder')).toBeNull()
    }
    const input = await renderInput('Find results', 'Names or paths...')
    expect(input.getAttribute('aria-placeholder')).toBe('Names or paths...')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
