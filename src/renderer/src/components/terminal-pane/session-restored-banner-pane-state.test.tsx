// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_RESUME_UNAVAILABLE_BANNER_TEXT } from './SessionRestoredBanner'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  pruneSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  syncSessionRestoredBannerTitleSpace,
  type SessionRestoredBannerPane,
  type SessionRestoredBannerPaneReasons
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
  paneIds: SessionRestoredBannerPaneReasons
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

function bannerReasons(paneIds: readonly number[]): SessionRestoredBannerPaneReasons {
  return new Map(paneIds.map((paneId) => [paneId, 'resume-unavailable' as const]))
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

  it('does not reserve title space for chromeless always-on pane headers', () => {
    const activePane = createPane(1)
    const secondPane = createPane(2)

    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: [activePane, secondPane],
      paneTitles: {},
      renamingPaneId: null,
      sessionRestoredBannerPaneIds: new Map()
    })

    expect(needsFit).toBe(false)
    expect(activePane.container.hasAttribute('data-has-title')).toBe(false)
    expect(secondPane.container.hasAttribute('data-has-title')).toBe(false)
  })

  it('reserves title space for explicit titles and inline rename', () => {
    const titledPane = createPane(1)
    const renamingPane = createPane(2)

    const needsFit = syncSessionRestoredBannerTitleSpace({
      panes: [titledPane, renamingPane],
      paneTitles: { [titledPane.id]: 'server' },
      renamingPaneId: renamingPane.id,
      sessionRestoredBannerPaneIds: new Map()
    })

    expect(needsFit).toBe(true)
    expect(titledPane.container.hasAttribute('data-has-title')).toBe(true)
    expect(renamingPane.container.hasAttribute('data-has-title')).toBe(true)
  })

  it('renders and reserves title space only on the restored inactive split pane', async () => {
    const activePane = createPane(1)
    const inactiveRestoredPane = createPane(2)
    const paneIds = bannerReasons([inactiveRestoredPane.id])

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
    expect(paneText(inactiveRestoredPane)).toBe(SESSION_RESUME_UNAVAILABLE_BANNER_TEXT)
  })

  it('keeps identity when the pane already shows the banner', () => {
    // Stable identity prevents unnecessary rerender.
    const shown = bannerReasons([1])

    expect(addSessionRestoredBannerPaneId(shown, 1, 'resume-unavailable')).toBe(shown)
  })

  it('dismisses only the interacted pane for pointer and key events', () => {
    const firstPane = createPane(1)
    const secondPane = createPane(2)
    const firstChild = document.createElement('button')
    const secondChild = document.createElement('button')
    firstPane.container.appendChild(firstChild)
    secondPane.container.appendChild(secondChild)

    const afterPointer = dismissSessionRestoredBannerPaneIds(
      bannerReasons([firstPane.id, secondPane.id]),
      eventFrom(secondChild, new PointerEvent('pointerdown', { bubbles: true })),
      [firstPane, secondPane]
    )
    const afterKey = dismissSessionRestoredBannerPaneIds(
      bannerReasons([firstPane.id, secondPane.id]),
      eventFrom(firstChild, new KeyboardEvent('keydown', { bubbles: true })),
      [firstPane, secondPane]
    )

    expect(afterPointer).toEqual(bannerReasons([firstPane.id]))
    expect(afterKey).toEqual(bannerReasons([secondPane.id]))
  })

  it('clears all restored banners when dismissal cannot resolve a pane', () => {
    const firstPane = createPane(1)
    const secondPane = createPane(2)
    const outside = document.createElement('button')
    document.body.appendChild(outside)

    const afterDismiss = dismissSessionRestoredBannerPaneIds(
      bannerReasons([firstPane.id, secondPane.id]),
      eventFrom(outside, new PointerEvent('pointerdown', { bubbles: true })),
      [firstPane, secondPane]
    )

    expect(afterDismiss).toEqual(new Map())
  })

  it('clears banners for closed or removed panes', () => {
    const firstPane = createPane(1)
    const secondPane = createPane(2)

    expect(
      removeSessionRestoredBannerPaneId(bannerReasons([firstPane.id, secondPane.id]), 2)
    ).toEqual(bannerReasons([firstPane.id]))
    expect(
      pruneSessionRestoredBannerPaneIds(bannerReasons([firstPane.id, secondPane.id]), [firstPane])
    ).toEqual(bannerReasons([firstPane.id]))
  })
})
