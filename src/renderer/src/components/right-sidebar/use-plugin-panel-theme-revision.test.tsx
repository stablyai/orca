// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { usePluginPanelThemeRevision } from './use-plugin-panel-theme-revision'

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderProbe(): { revisions: number[] } {
  const revisions: number[] = []
  function Probe(): null {
    revisions.push(usePluginPanelThemeRevision())
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Probe />))
  return { revisions }
}

async function flushObserver(): Promise<void> {
  // MutationObserver delivers on a microtask; give React a chance to re-render.
  await act(async () => {
    await Promise.resolve()
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
})

describe('usePluginPanelThemeRevision', () => {
  it('bumps when the root theme class changes', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    document.documentElement.className = 'dark'
    await flushObserver()

    expect(revisions.at(-1)).toBeGreaterThan(before!)
  })

  it('bumps when root design tokens change', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    document.documentElement.style.setProperty('--background', '#000')
    await flushObserver()

    expect(revisions.at(-1)).toBeGreaterThan(before!)
  })

  it('ignores mutations outside the document root', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    container!.className = 'unrelated'
    await flushObserver()

    expect(revisions.at(-1)).toBe(before)
  })

  // The revision keys the panel iframe, so a bump here destroys in-panel state.
  it('ignores root custom properties the panel shell does not bake in', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    // Written every rAF while dragging the sidebar divider.
    for (const width of [240, 241, 242, 243]) {
      document.documentElement.style.setProperty('--workspace-sidebar-live-width', `${width}px`)
      await flushObserver()
    }

    expect(revisions.at(-1)).toBe(before)
  })

  it('ignores a class change that leaves the color scheme alone', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    document.documentElement.classList.add('theme-transition-disabled')
    await flushObserver()

    expect(revisions.at(-1)).toBe(before)
  })

  it('bumps once when a token settles on a new value', async () => {
    const { revisions } = renderProbe()
    const before = revisions.at(-1)

    document.documentElement.style.setProperty('--background', '#111')
    await flushObserver()
    document.documentElement.style.setProperty('--background', '#111')
    await flushObserver()

    expect(revisions.at(-1)).toBe(before! + 1)
  })
})
