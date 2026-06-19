// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_RESTORED_BANNER_TEXT } from './SessionRestoredBanner'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  pruneSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  seedStartupSessionRestoredBanner,
  syncSessionRestoredBannerTitleSpace,
  type SessionRestoredBannerPane
} from './session-restored-banner-pane-state'

const mountedRoots: Root[] = []

function createPane(id: number): SessionRestoredBannerPane {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.leafId = `leaf-${id}`
  document.body.appendChild(container)
  return { id, container }
}

async function renderPortals(
  panes: readonly SessionRestoredBannerPane[],
  paneIds: ReadonlySet<number>
): Promise<void> {
  const rootContainer = document.createElement('div')
  document.body.appendChild(rootContainer)
  const root = createRoot(rootContainer)
  mountedRoots.push(root)
  await act(async () => {
    root.render(<SessionRestoredBannerPortals panes={panes} paneIds={paneIds} />)
  })
}

function eventFrom(target: HTMLElement, event: KeyboardEvent | PointerEvent): typeof event {
  target.dispatchEvent(event)
  return event
}

function paneText(pane: SessionRestoredBannerPane): string {
  return pane.container.textContent ?? ''
}

describe('session restored banner pane state', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('seeds sidebar startup onto the created pane and renders its overlay there', async () => {
    const firstPane = createPane(1)
    const createdPane = createPane(2)
    let paneIds = new Set<number>()

    seedStartupSessionRestoredBanner(
      { showSessionRestoredBanner: true },
      createdPane.id,
      (paneId) => {
        paneIds = addSessionRestoredBannerPaneId(paneIds, paneId)
      }
    )
    await renderPortals([firstPane, createdPane], paneIds)

    expect(paneIds).toEqual(new Set([createdPane.id]))
    expect(paneText(firstPane)).toBe('')
    expect(paneText(createdPane)).toBe(SESSION_RESTORED_BANNER_TEXT)
  })

  it('renders and reserves title space only on the restored inactive split pane', async () => {
    const activePane = createPane(1)
    const inactiveRestoredPane = createPane(2)
    const paneIds = new Set([inactiveRestoredPane.id])

    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: [activePane, inactiveRestoredPane],
      paneTitles: {},
      renamingPaneId: null,
      sessionRestoredBannerPaneIds: paneIds
    })
    await renderPortals([activePane, inactiveRestoredPane], paneIds)

    expect(needsFit).toBe(true)
    expect(activePane.container.hasAttribute('data-has-title')).toBe(false)
    expect(inactiveRestoredPane.container.hasAttribute('data-has-title')).toBe(true)
    expect(paneText(activePane)).toBe('')
    expect(paneText(inactiveRestoredPane)).toBe(SESSION_RESTORED_BANNER_TEXT)
  })

  it('dismisses only the interacted pane for pointer and key events', () => {
    const firstPane = createPane(1)
    const secondPane = createPane(2)
    const firstChild = document.createElement('button')
    const secondChild = document.createElement('button')
    firstPane.container.appendChild(firstChild)
    secondPane.container.appendChild(secondChild)

    const afterPointer = dismissSessionRestoredBannerPaneIds(
      new Set([firstPane.id, secondPane.id]),
      eventFrom(secondChild, new PointerEvent('pointerdown', { bubbles: true })),
      [firstPane, secondPane]
    )
    const afterKey = dismissSessionRestoredBannerPaneIds(
      new Set([firstPane.id, secondPane.id]),
      eventFrom(firstChild, new KeyboardEvent('keydown', { bubbles: true })),
      [firstPane, secondPane]
    )

    expect(afterPointer).toEqual(new Set([firstPane.id]))
    expect(afterKey).toEqual(new Set([secondPane.id]))
  })

  it('clears all restored banners when dismissal cannot resolve a pane', () => {
    const firstPane = createPane(1)
    const secondPane = createPane(2)
    const outside = document.createElement('button')
    document.body.appendChild(outside)

    const afterDismiss = dismissSessionRestoredBannerPaneIds(
      new Set([firstPane.id, secondPane.id]),
      eventFrom(outside, new PointerEvent('pointerdown', { bubbles: true })),
      [firstPane, secondPane]
    )

    expect(afterDismiss).toEqual(new Set())
  })

  it('clears banners for closed or removed panes', () => {
    const firstPane = createPane(1)
    const secondPane = createPane(2)

    expect(removeSessionRestoredBannerPaneId(new Set([firstPane.id, secondPane.id]), 2)).toEqual(
      new Set([firstPane.id])
    )
    expect(
      pruneSessionRestoredBannerPaneIds(new Set([firstPane.id, secondPane.id]), [firstPane])
    ).toEqual(new Set([firstPane.id]))
  })
})
