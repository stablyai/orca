// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../../i18n/i18n'

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
      frameWidth: 32,
      frameHeight: 24,
      columns: 6,
      rows: 1,
      sheetWidth: 192,
      sheetHeight: 24,
      fps: 6,
      defaultAnimation: 'idle',
      animations: {
        idle: { row: 0, frames: 6 }
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

describe('PetOverlay sprite keyframes', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    installLocalStorage()
  })

  afterEach(async () => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    await i18n.changeLanguage('en')
  })

  it('keeps custom spritesheet keyframes valid in translated locales', () => {
    ;({ container, root } = renderPetOverlay())

    const css = Array.from(container.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')

    expect(css).toContain('@keyframes pet-bob')
    expect(css).toContain('transform: translateY(0)')
    expect(css).toContain('background-position:')
    expect(css).toContain('to { background-position:')
    expect(css).not.toContain('变换')
    expect(css).not.toContain('背景位置')
    expect(css).not.toContain('到 {')
  })
})
