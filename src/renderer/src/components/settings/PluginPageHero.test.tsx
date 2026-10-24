// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginScreenshots } from './PluginPageHero'

const images = {
  cover: { url: 'orca-plugin-image://sha/cover', alt: 'Cover' },
  screenshots: [
    { url: 'orca-plugin-image://sha/cover', alt: 'Cover again' },
    { url: 'orca-plugin-image://sha/one', alt: 'First', caption: 'The first view' },
    { url: 'orca-plugin-image://sha/two', alt: 'Second' }
  ]
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root?.render(<PluginScreenshots images={images} />))
  return container
}

describe('PluginScreenshots', () => {
  it('skips a screenshot that is the cover', async () => {
    const container = await render()
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('pages with arrow keys, closes on Escape and returns focus to its thumbnail', async () => {
    const container = await render()
    const second = container.querySelectorAll('button')[1]!
    await act(async () => second.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('2 of 2')
    // Why scrollable: on a short window the image shrinks and the close button stays reachable.
    expect(dialog.className).toContain('overflow-y-auto')

    await act(async () =>
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('1 of 2')

    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    )
    // Why a tick: the dialog hands focus back as its focus scope unmounts.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(second)
  })
})
