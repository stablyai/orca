/**
 * Composes the real chain a host guest's paint retention depends on, across the main/renderer
 * boundary that neither side's own suite can see:
 *
 *   runtime subscriber set
 *     -> the two IPC snapshots the renderer hydrates from on reload
 *        (`runtime:getBrowserDrivers`, `runtime:getBrowserRemoteViewerPages`)
 *     -> isBrowserPagePanePaintable, which decides display:none on the guest.
 *
 * Chromium never paints inside a display:none subtree, so a guest parked that way stops emitting
 * the frames its subscriber asked for. Scoping the mobile driver stamp to genuinely mobile clients
 * removed the only term that had been covering a paired desktop/web/CLI viewer, which left such a
 * viewer receiving frames only while the host operator happened to be looking at the same page.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  createScreencastHarness,
  HARNESS_PAGE_ID as PAGE
} from '../../src/main/runtime/browser-screencast-subscriber-test-harness'
import {
  hasMobileDriverForAnyBrowserPage,
  hydrateBrowserDrivers
} from '../../src/renderer/src/lib/pane-manager/browser-mobile-driver-state'
import {
  hasRemoteViewerForAnyBrowserPage,
  hydrateBrowserRemoteViewerPages
} from '../../src/renderer/src/lib/pane-manager/browser-remote-viewer-state'
import { isBrowserPagePanePaintable } from '../../src/renderer/src/components/browser-pane/host-guest/browser-page-paintability'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

function hostGuestIsPaintable(
  runtime: OrcaRuntimeService,
  hostIsLookingAtThisPage: boolean
): boolean {
  hydrateBrowserDrivers(
    [...runtime.getAllBrowserDrivers()].map(([browserPageId, driver]) => ({
      browserPageId,
      driver
    }))
  )
  hydrateBrowserRemoteViewerPages(runtime.getBrowserRemoteViewerPages())
  return isBrowserPagePanePaintable({
    isActive: hostIsLookingAtThisPage,
    // No agent command is in flight, so no automation bootstrap lease is held. That lease is what
    // mounts a cold guest; it is released as soon as the command returns and cannot retain one.
    isAutomationVisible: false,
    isMobileDriven: hasMobileDriverForAnyBrowserPage([PAGE]),
    hasRemoteViewer: hasRemoteViewerForAnyBrowserPage([PAGE])
  })
}

describe('host guest paint retention for a remote screencast subscriber', () => {
  it('keeps the guest painting for a phone subscriber while the host looks elsewhere', async () => {
    const { runtime, subscribe } = createScreencastHarness()
    const phone = subscribe({ connectionId: 'conn-phone', clientKind: 'mobile' })
    await phone.streaming()
    expect(hostGuestIsPaintable(runtime, false)).toBe(true)
    phone.stop()
    await phone.done
  })

  it('keeps the guest painting for a paired desktop or web subscriber while the host looks elsewhere', async () => {
    const { runtime, subscribe } = createScreencastHarness()
    const desktop = subscribe({ connectionId: 'conn-desktop', clientKind: 'runtime' })
    await desktop.streaming()
    expect(hostGuestIsPaintable(runtime, false)).toBe(true)
    desktop.stop()
    await desktop.done
  })

  it('keeps a co-viewing desktop client painting after the phone is taken back', async () => {
    const { runtime, subscribe } = createScreencastHarness()
    const phone = subscribe({ connectionId: 'conn-phone', clientKind: 'mobile' })
    await phone.streaming()
    const desktop = subscribe({ connectionId: 'conn-desktop', clientKind: 'runtime' })
    await desktop.streaming()

    runtime.reclaimBrowserForDesktop(PAGE)
    await phone.done
    expect(hostGuestIsPaintable(runtime, false)).toBe(true)

    desktop.stop()
    await desktop.done
  })

  it('parks the guest once nothing is watching and the host looks elsewhere', async () => {
    const { runtime, subscribe } = createScreencastHarness()
    const desktop = subscribe({ connectionId: 'conn-desktop', clientKind: 'runtime' })
    await desktop.streaming()
    desktop.stop()
    await desktop.done

    // Presence: the same call still reports true while the host looks at the page, so the false
    // below is a real park and not an oracle that never returns true.
    expect(hostGuestIsPaintable(runtime, true)).toBe(true)
    expect(hostGuestIsPaintable(runtime, false)).toBe(false)
  })
})
