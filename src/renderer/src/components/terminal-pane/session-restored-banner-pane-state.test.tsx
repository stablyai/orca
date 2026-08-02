// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SESSION_RESTORED_BANNER_TEXT,
  SESSION_RESUME_UNAVAILABLE_BANNER_TEXT
} from './SessionRestoredBanner'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  pruneSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  seedStartupSessionRestoredBanner,
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
  return new Map(paneIds.map((paneId) => [paneId, 'restored' as const]))
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
    let paneIds: SessionRestoredBannerPaneReasons = new Map()

    seedStartupSessionRestoredBanner(
      { showSessionRestoredBanner: true },
      createdPane.id,
      (paneId) => {
        paneIds = addSessionRestoredBannerPaneId(paneIds, paneId)
      }
    )
    await renderPortals([firstPane, createdPane], paneIds)

    expect(paneIds).toEqual(new Map([[createdPane.id, 'restored']]))
    expect(paneText(firstPane)).toBe('')
    expect(paneText(createdPane)).toBe(SESSION_RESTORED_BANNER_TEXT)
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
    const paneIds = new Map<number, 'restored'>([[inactiveRestoredPane.id, 'restored']])

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

  it('names a fresh session when the requested resume could not be verified', async () => {
    const restoredPane = createPane(1)
    const freshPane = createPane(2)

    await renderPortals(
      [restoredPane, freshPane],
      new Map([
        [restoredPane.id, 'restored' as const],
        [freshPane.id, 'resume-unavailable' as const]
      ])
    )

    expect(paneText(restoredPane)).toBe(SESSION_RESTORED_BANNER_TEXT)
    expect(paneText(freshPane)).toBe(SESSION_RESUME_UNAVAILABLE_BANNER_TEXT)
  })

  it('upgrades a restored pane to resume-unavailable and keeps identity otherwise', () => {
    // Why: the reason must win over the earlier one — a pane that turned out to be a fresh
    // session cannot keep claiming a restore. Identity is what stops a needless re-render.
    const restored = new Map<number, 'restored'>([[1, 'restored']])

    expect(addSessionRestoredBannerPaneId(restored, 1, 'resume-unavailable')).toEqual(
      new Map([[1, 'resume-unavailable']])
    )
    expect(addSessionRestoredBannerPaneId(restored, 1, 'restored')).toBe(restored)
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
