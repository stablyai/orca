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
  return [...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]
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
})
