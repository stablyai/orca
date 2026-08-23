// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => ({
  state: {
    petVisible: true,
    setPetVisible: vi.fn(),
    petId: 'claude-the-mage',
    setPetId: vi.fn(),
    customPets: [] as unknown[],
    addCustomPet: vi.fn(),
    removeCustomPet: vi.fn(),
    petSize: 180,
    setPetSize: vi.fn(),
    petWalks: true,
    setPetWalks: vi.fn(),
    petReturnsToLane: true,
    setPetReturnsToLane: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  } as Record<string, unknown>
}))

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeMock.state),
    { getState: () => storeMock.state }
  )
  return { useAppStore }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

// Why: the dialog drags in the canvas pipeline. This file is about the menu's
// behaviour, so the dialog is reduced to a marker of whether it is open.
vi.mock('../pet/PetFromImageDialog', () => ({
  PetFromImageDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="from-image-dialog" /> : null
}))

import { PetStatusSegment } from './PetStatusSegment'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<PetStatusSegment />)
  })
}

function menuItems(): HTMLElement[] {
  return [
    ...document.querySelectorAll(
      '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
    )
  ] as HTMLElement[]
}

function openMenu(): void {
  const trigger = document.querySelector('[aria-label="Pet menu"]') as HTMLElement
  act(() => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
}

function selectItem(match: RegExp): void {
  const item = menuItems().find((el) => match.test(el.textContent ?? ''))
  if (!item) {
    throw new Error(`no menu item matching ${match}`)
  }
  act(() => {
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    item.click()
  })
}

beforeEach(() => {
  storeMock.state.petWalks = true
  storeMock.state.petReturnsToLane = true
  storeMock.state.customPets = []
  storeMock.state.petSize = 180
  ;(storeMock.state.setPetSize as ReturnType<typeof vi.fn>).mockClear()
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

describe('PetStatusSegment', () => {
  it('opens the pet menu from the status bar', () => {
    render()

    openMenu()

    expect(menuItems().length).toBeGreaterThan(0)
  })

  it('closes the menu when opening the image dialog', () => {
    render()
    openMenu()

    selectItem(/create pet from image/i)

    // Why: leaving the menu open behind the dialog looks harmless, but the next
    // click on the trigger then toggles the still-open menu shut — which reads
    // as "the menu stopped working".
    expect(document.querySelector('[data-testid="from-image-dialog"]')).not.toBeNull()
    expect(menuItems()).toHaveLength(0)
  })

  it('keeps the menu open for the toggles, which are meant to be used in a row', () => {
    render()
    openMenu()

    selectItem(/walk around/i)

    expect(storeMock.state.setPetWalks).toHaveBeenCalledWith(false)
    expect(menuItems().length).toBeGreaterThan(0)
  })

  it('states the toggles as checked, rather than drawing a tick nothing announces', () => {
    storeMock.state.petReturnsToLane = false
    render()
    openMenu()

    const walk = menuItems().find((el) => /walk around/i.test(el.textContent ?? ''))
    const lane = menuItems().find((el) => /drop to the floor/i.test(el.textContent ?? ''))

    expect(walk?.getAttribute('role')).toBe('menuitemcheckbox')
    expect(walk?.getAttribute('aria-checked')).toBe('true')
    expect(lane?.getAttribute('aria-checked')).toBe('false')
  })

  it('gives removing a custom pet a menu item of its own', () => {
    // Why: the remove control used to be a <button> inside a role="menuitem" —
    // invalid, and unreachable by the arrow keys that drive a menu.
    storeMock.state.customPets = [{ id: 'custom-1', label: 'Mine' }]
    render()
    openMenu()

    expect(menuItems().some((el) => /remove a pet/i.test(el.textContent ?? ''))).toBe(true)
    expect(document.querySelector('[role^="menuitem"] button')).toBeNull()
  })

  it('resizes the pet with the design-system slider, as the image dialog does', () => {
    render()
    openMenu()

    const thumb = document.querySelector('[data-slot="slider-thumb"]') as HTMLElement
    expect(thumb).not.toBeNull()
    act(() => {
      thumb.focus()
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })

    expect(storeMock.state.setPetSize).toHaveBeenCalledWith(190)
    expect(menuItems().length).toBeGreaterThan(0)
  })

  it('offers no removal entry when there is nothing custom to remove', () => {
    render()
    openMenu()

    expect(menuItems().some((el) => /remove a pet/i.test(el.textContent ?? ''))).toBe(false)
  })
})
