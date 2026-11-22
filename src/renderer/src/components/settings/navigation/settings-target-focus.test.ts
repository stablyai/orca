// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingSettingsTargetFocus,
  focusSettingsTargetWhenVisible,
  startRevealedSettingsTargetFocus
} from './settings-target-focus'
import type { SettingsDeepLinkTargetWatch } from './settings-deep-link-target-watcher'

const SECTION_ID = 'chat-names-agent'

// happy-dom does no layout: treat anything outside a `hidden` subtree as laid out.
function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const rects = this.closest('[hidden]') ? [] : [new DOMRect(0, 0, 10, 10)]
    const list: DOMRectList = Object.assign(rects, {
      item: (index: number) => rects[index] ?? null
    })
    return list
  })
}

async function settle(): Promise<void> {
  // Two animation frames (layout wait) plus the observer's microtask.
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  }
}

function mountSettings(): { root: HTMLElement; userInput: HTMLInputElement } {
  const root = document.createElement('div')
  const userInput = document.createElement('input')
  root.append(userInput)
  document.body.append(root)
  return { root, userInput }
}

function mountRow(parent: HTMLElement): HTMLButtonElement {
  const row = document.createElement('div')
  row.id = SECTION_ID
  const picker = document.createElement('button')
  picker.textContent = 'Select agent'
  row.append(picker)
  parent.append(row)
  return picker
}

describe('focusSettingsTargetWhenVisible', () => {
  beforeEach(() => {
    stubLayout()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('focuses an already-mounted row once its collapsed disclosure drops `hidden`', async () => {
    const { root } = mountSettings()
    const disclosure = document.createElement('div')
    disclosure.hidden = true
    root.append(disclosure)
    const picker = mountRow(disclosure)

    const watch = focusSettingsTargetWhenVisible({ root, sectionId: SECTION_ID })
    await settle()
    expect(document.activeElement).not.toBe(picker)

    // Only an attribute changes: no node is added or removed.
    disclosure.hidden = false
    await settle()
    expect(document.activeElement).toBe(picker)
    watch.cancel()
  })

  it('leaves focus where the user put it when the request was cancelled before the row mounted', async () => {
    const { root, userInput } = mountSettings()
    const watchRef: { current: SettingsDeepLinkTargetWatch | null } = {
      current: focusSettingsTargetWhenVisible({ root, sectionId: SECTION_ID })
    }
    const pendingFocusTargetRef: { current: string | null } = { current: null }

    // Closing Settings, a pane pick, or a newer navigation cancels the request.
    cancelPendingSettingsTargetFocus({ pendingFocusTargetRef, pendingFocusWatchRef: watchRef })
    expect(watchRef.current).toBeNull()
    userInput.focus()
    const picker = mountRow(root)
    await settle()

    expect(document.activeElement).toBe(userInput)
    expect(document.activeElement).not.toBe(picker)
  })

  it('gives up once the user acts before the row appears', async () => {
    const { root, userInput } = mountSettings()
    const watch = focusSettingsTargetWhenVisible({ root, sectionId: SECTION_ID })

    userInput.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    userInput.focus()
    mountRow(root)
    await settle()

    expect(document.activeElement).toBe(userInput)
    watch.cancel()
  })

  it('starts focus only for the reveal of the target that asked for it', async () => {
    const { root, userInput } = mountSettings()
    const pendingFocusTargetRef: { current: string | null } = { current: SECTION_ID }
    const pendingFocusWatchRef: { current: SettingsDeepLinkTargetWatch | null } = { current: null }
    const refs = { pendingFocusTargetRef, pendingFocusWatchRef }
    userInput.focus()
    const picker = mountRow(root)

    // A newer navigation revealed another row: the old request stays unstarted.
    startRevealedSettingsTargetFocus(refs, root, 'another-row')
    await settle()
    expect(document.activeElement).toBe(userInput)

    startRevealedSettingsTargetFocus(refs, root, SECTION_ID)
    await settle()
    expect(document.activeElement).toBe(picker)
    expect(pendingFocusTargetRef.current).toBeNull()
    cancelPendingSettingsTargetFocus(refs)
  })
})
