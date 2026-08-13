// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  document.body.innerHTML = ''
})

async function renderPopover(): Promise<HTMLButtonElement> {
  const { default: WorktreeVisibilityHelpPopover } = await import('./WorktreeVisibilityHelpPopover')
  await act(async () => root.render(<WorktreeVisibilityHelpPopover />))
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Which worktrees are hidden by default?"]'
  )
  if (!trigger) {
    throw new Error('Missing worktree visibility help trigger')
  }
  return trigger
}

function content(): HTMLElement | null {
  return document.querySelector('[data-slot="popover-content"]')
}

async function dispatch(target: EventTarget, event: Event): Promise<void> {
  await act(async () => target.dispatchEvent(event))
}

describe('WorktreeVisibilityHelpPopover', () => {
  it('stays closed when the trigger receives initial dialog focus', async () => {
    const trigger = await renderPopover()

    await act(async () => trigger.focus())

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(content()).toBeNull()
  })

  it('opens on pointer hover and closes when the pointer leaves', async () => {
    const trigger = await renderPopover()
    const hoverTarget = trigger.parentElement
    expect(hoverTarget).not.toBeNull()

    await dispatch(
      hoverTarget!,
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })
    )

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(content()?.getAttribute('aria-label')).toBe('Which worktrees are hidden by default?')
    expect(content()?.textContent).toContain('current and future non-Orca worktrees')
    expect(content()?.textContent).toContain('.claude/worktrees/*')
    expect(content()?.textContent).toContain('.gsd-workspaces/*')

    await dispatch(
      hoverTarget!,
      new PointerEvent('pointerout', {
        bubbles: true,
        pointerType: 'mouse',
        relatedTarget: document.body
      })
    )

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(content()).toBeNull()
  })

  it('opens without moving focus and dismisses with Escape', async () => {
    const trigger = await renderPopover()
    trigger.focus()

    await dispatch(trigger, new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(trigger)

    await dispatch(
      document,
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses when the user clicks outside', async () => {
    const trigger = await renderPopover()
    await dispatch(trigger, new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })
      )
      document.body.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' })
      )
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
