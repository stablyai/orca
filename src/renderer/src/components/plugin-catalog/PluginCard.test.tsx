// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { PluginCard } from './PluginCard'
import type { PluginListEntry } from './plugin-list-entries'

const entry: PluginListEntry = {
  pluginKey: 'acme.dusk',
  name: 'Dusk',
  publisher: 'acme',
  version: '1.0.0',
  description: 'A violet theme.',
  official: false,
  categories: ['themes'],
  types: ['app-theme'],
  minimumOrca: null,
  updateVersion: null,
  catalogIds: [],
  updatable: false,
  installed: null,
  listing: null
}

describe('PluginCard', () => {
  it('has two sibling tab stops, a stretched name link and the action, nothing nested', () => {
    const container = document.createElement('ul')
    const onOpen = vi.fn()
    const onInstall = vi.fn()
    act(() =>
      createRoot(container).render(
        <PluginCard
          entry={entry}
          palettes={[]}
          onOpen={onOpen}
          action={<button onClick={onInstall}>Install</button>}
        />
      )
    )
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['Dusk', 'Install'])
    expect(buttons.some((button) => button.querySelector('button, a'))).toBe(false)
    expect(container.querySelector('[aria-hidden="true"]')?.querySelector('button')).toBeNull()

    act(() => buttons[0]?.click())
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onInstall).not.toHaveBeenCalled()
  })

  it('wraps footer chips instead of clipping them beside the fixed action slot', () => {
    const container = document.createElement('ul')
    act(() =>
      createRoot(container).render(
        <PluginCard
          entry={entry}
          palettes={[]}
          onOpen={vi.fn()}
          chips={
            <>
              <span data-chip="">Adds a panel</span>
              <span data-chip="">Unverified</span>
            </>
          }
          action={<button className="w-32">Review &amp; install</button>}
        />
      )
    )
    const chips = container.querySelectorAll('[data-chip]')
    expect(chips).toHaveLength(2)
    const chipRow = chips[0]?.parentElement
    expect(chipRow?.classList.contains('flex-wrap')).toBe(true)
    expect(chipRow?.classList.contains('overflow-hidden')).toBe(false)
    expect(chipRow?.classList.contains('min-w-0')).toBe(true)
    // The footer wraps too, so a card too narrow for chips plus action drops the action below them.
    const footer = chipRow?.parentElement
    expect(footer?.classList.contains('flex-wrap')).toBe(true)
    // The slot is as wide as the button it holds and never shrinks, so the chips keep the rest.
    const slot = container.querySelector('button.w-32')?.parentElement
    expect(slot?.parentElement).toBe(footer)
    expect(slot?.classList.contains('w-32')).toBe(true)
    expect(slot?.classList.contains('shrink-0')).toBe(true)
    expect(slot?.classList.contains('ml-auto')).toBe(true)
  })
})
