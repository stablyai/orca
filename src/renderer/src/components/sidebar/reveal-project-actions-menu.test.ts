// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PROJECT_ACTIONS_TRIGGER_ATTRIBUTE,
  PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE,
  revealProjectActionsMenu
} from './reveal-project-actions-menu'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function addTrigger(repoId: string, { withGroupRow = true } = {}): HTMLButtonElement {
  const trigger = document.createElement('button')
  trigger.setAttribute(PROJECT_ACTIONS_TRIGGER_ATTRIBUTE, repoId)
  trigger.setAttribute('data-repo-header-action', '')
  if (!withGroupRow) {
    document.body.appendChild(trigger)
    return trigger
  }
  const row = document.createElement('div')
  row.className = 'group relative flex'
  row.appendChild(trigger)
  document.body.appendChild(row)
  return trigger
}

describe('revealProjectActionsMenu', () => {
  it('presses the trigger with pointerdown, the only event Radix opens on', () => {
    const trigger = addTrigger('repo-1')
    const pointerDown = vi.fn()
    const click = vi.fn()
    trigger.addEventListener('pointerdown', pointerDown)
    trigger.addEventListener('click', click)

    expect(revealProjectActionsMenu('repo-1', { doc: document })).toBe(true)
    expect(pointerDown).toHaveBeenCalledTimes(1)
    expect(click).not.toHaveBeenCalled()
  })

  it('highlights the visibility entry once the menu content has mounted', async () => {
    const trigger = addTrigger('repo-1')
    // Why: Radix mounts menu content on open, which is what pressing the trigger does.
    trigger.addEventListener('pointerdown', () => {
      const item = document.createElement('div')
      item.tabIndex = -1
      item.setAttribute(PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE, '')
      document.body.appendChild(item)
    })

    revealProjectActionsMenu('repo-1', { doc: document })
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

    expect(document.activeElement?.hasAttribute(PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE)).toBe(
      true
    )
  })

  it('reports failure when that project header is not mounted, so callers can fall back', () => {
    addTrigger('repo-1')

    expect(revealProjectActionsMenu('repo-2', { doc: document })).toBe(false)
  })

  it('does not break on a repo id carrying selector-hostile characters', () => {
    const trigger = addTrigger('repo"1')
    const pointerDown = vi.fn()
    trigger.addEventListener('pointerdown', pointerDown)

    expect(revealProjectActionsMenu('repo"1', { doc: document })).toBe(true)
    expect(pointerDown).toHaveBeenCalledTimes(1)
  })

  it('marks the hover group so the whole action cluster is revealed', () => {
    const trigger = addTrigger('repo-1')

    revealProjectActionsMenu('repo-1', { doc: document })

    expect(trigger.closest('.group')?.hasAttribute('data-guided-actions')).toBe(true)
    expect(trigger.hasAttribute('data-guided-actions')).toBe(false)
  })

  it('falls back to the trigger itself when no hover group wraps it', () => {
    const trigger = addTrigger('repo-1', { withGroupRow: false })

    revealProjectActionsMenu('repo-1', { doc: document })

    expect(trigger.hasAttribute('data-guided-actions')).toBe(true)
  })

  it('drops the mark and calls back when the menu never opens', async () => {
    const trigger = addTrigger('repo-1')
    const onUnreachable = vi.fn()

    revealProjectActionsMenu('repo-1', { doc: document, onUnreachable })
    expect(trigger.closest('.group')?.hasAttribute('data-guided-actions')).toBe(true)

    for (let frame = 0; frame < 14; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    }

    expect(onUnreachable).toHaveBeenCalledTimes(1)
    expect(trigger.closest('.group')?.hasAttribute('data-guided-actions')).toBe(false)
  })

  it('drops the keyboard retry once the user has moved focus elsewhere', async () => {
    const trigger = addTrigger('repo-1')
    const focus = vi.spyOn(trigger, 'focus')
    const elsewhere = document.createElement('input')
    document.body.appendChild(elsewhere)

    revealProjectActionsMenu('repo-1', { doc: document })
    elsewhere.focus()

    for (let frame = 0; frame < 14; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    }

    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('still retries by keyboard while focus has not moved', async () => {
    const trigger = addTrigger('repo-1')
    const keydown = vi.fn()
    trigger.addEventListener('keydown', keydown)

    revealProjectActionsMenu('repo-1', { doc: document })

    for (let frame = 0; frame < 14; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    }

    expect(keydown).toHaveBeenCalledTimes(1)
  })

  it('keeps the mark while the menu is open and clears it when the item leaves', async () => {
    const trigger = addTrigger('repo-1')
    trigger.addEventListener('pointerdown', () => {
      const mounted = document.createElement('div')
      mounted.tabIndex = -1
      mounted.setAttribute(PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE, '')
      document.body.appendChild(mounted)
    })

    revealProjectActionsMenu('repo-1', { doc: document })
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    const row = trigger.closest('.group')
    expect(row?.hasAttribute('data-guided-actions')).toBe(true)

    document.querySelector(`[${PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE}]`)?.remove()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(row?.hasAttribute('data-guided-actions')).toBe(false)
  })
})
