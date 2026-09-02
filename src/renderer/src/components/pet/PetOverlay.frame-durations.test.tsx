// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  agentStatusByPaneKey: {},
  agentStatusEpoch: 0,
  retainedAgentsByPaneKey: {},
  petSize: 180
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => {
      return selector(storeState)
    },
    {
      getState: () => storeState
    }
  )
}))

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({
    url: 'blob:custom-pet',
    ready: true,
    sprite: {
      frameWidth: 192,
      frameHeight: 208,
      columns: 8,
      rows: 9,
      sheetWidth: 1536,
      sheetHeight: 1872,
      fps: 8,
      defaultAnimation: 'idle',
      animations: {
        // Codex ambient idle pacing: 6.6s cycle with long bookend holds.
        idle: { row: 0, frames: 6, frameDurationsMs: [1680, 660, 660, 840, 840, 1920] }
      }
    },
    detected: null
  })
}))

import { PetOverlay } from './PetOverlay'

function renderPetOverlay(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<PetOverlay />)
  })
  return { container, root }
}

function installLocalStorage(): void {
  const values = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    }
  })
}

describe('PetOverlay per-frame sprite durations', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('emits one held keyframe stop per frame instead of uniform steps()', () => {
    ;({ container, root } = renderPetOverlay())

    const css = Array.from(container.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')

    // Cumulative stops for [1680, 660, 660, 840, 840, 1920] over 6600ms.
    expect(css).toContain('0% { background-position: 0px 0px; }')
    expect(css).toContain('25.4545%')
    expect(css).toContain('35.4545%')
    expect(css).toContain('45.4545%')
    expect(css).toContain('58.1818%')
    expect(css).toContain('70.9091%')
    expect(css).not.toContain('to { background-position:')

    const spriteDiv = Array.from(container.querySelectorAll('div')).find(
      (div) => div.style.backgroundImage !== ''
    )
    expect(spriteDiv?.style.animation).toContain('6.6s')
    expect(spriteDiv?.style.animation).toContain('step-end')
    expect(spriteDiv?.style.animation).toContain('infinite')
  })
})
