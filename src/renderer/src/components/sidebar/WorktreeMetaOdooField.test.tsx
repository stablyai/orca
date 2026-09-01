// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeMetaOdooField } from './WorktreeMetaOdooField'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

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

describe('WorktreeMetaOdooField', () => {
  it('names the input through its label', async () => {
    await act(async () =>
      root.render(<WorktreeMetaOdooField value="" onChange={vi.fn()} onEnter={vi.fn()} />)
    )

    const label = container.querySelector('label')
    const input = container.querySelector('input')
    expect(label?.getAttribute('for')).toBeTruthy()
    expect(input?.id).toBe(label?.getAttribute('for'))
    expect(label?.textContent).toBe('Odoo Ticket')
  })
})
