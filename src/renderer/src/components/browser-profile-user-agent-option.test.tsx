// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProfileUserAgentOption } from './browser-profile-user-agent-option'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function renderOption(): HTMLDivElement {
  function Harness(): React.JSX.Element {
    const [checked, setChecked] = useState(false)
    return <BrowserProfileUserAgentOption checked={checked} onCheckedChange={setChecked} />
  }

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<Harness />))
  return container
}

describe('BrowserProfileUserAgentOption', () => {
  it('explains the compatibility tradeoff and toggles the native mode', () => {
    const rendered = renderOption()
    const checkbox = rendered.querySelector<HTMLButtonElement>('[role="checkbox"]')

    expect(rendered.textContent).toContain('May improve Google sign-in')
    expect(checkbox?.getAttribute('aria-checked')).toBe('false')

    act(() => checkbox?.click())

    expect(checkbox?.getAttribute('aria-checked')).toBe('true')
  })
})
