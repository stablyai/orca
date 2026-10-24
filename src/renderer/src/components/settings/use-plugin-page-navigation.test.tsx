// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { usePluginPageNavigation, type PluginPageNavigation } from './use-plugin-page-navigation'

let root: Root | null = null
let nav: PluginPageNavigation | null = null

function Harness(): React.JSX.Element {
  nav = usePluginPageNavigation()
  return (
    <>
      <input aria-label="field" />
      <div role="dialog">
        <button>inside dialog</button>
      </div>
      <button data-plain>plain</button>
    </>
  )
}

async function mountOpen(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(<Harness />))
  await act(async () => nav?.open('acme.notes'))
  return container
}

function pressBack(target: Element | null): void {
  target?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })
  )
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('usePluginPageNavigation', () => {
  it('leaves Alt+← to text fields and dialogs', async () => {
    const container = await mountOpen()
    await act(async () => pressBack(container.querySelector('input')))
    await act(async () => pressBack(container.querySelector('[role="dialog"] button')))
    expect(nav?.openKey).toBe('acme.notes')
  })

  it('goes back on Alt+← from anywhere else', async () => {
    const container = await mountOpen()
    await act(async () => pressBack(container.querySelector('[data-plain]')))
    expect(nav?.openKey).toBeNull()
  })

  it('leaves only the page that is open', async () => {
    await mountOpen()
    await act(async () => nav?.leave('acme.other'))
    expect(nav?.openKey).toBe('acme.notes')
    await act(async () => nav?.leave('acme.notes'))
    expect(nav?.openKey).toBeNull()
  })
})
