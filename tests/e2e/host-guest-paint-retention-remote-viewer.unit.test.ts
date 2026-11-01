// Test runtime subscribers → reload IPC snapshots → isBrowserPagePanePaintable across main/renderer.
// Nonmobile remote viewers must retain guest paint after automation leases expire and the host looks elsewhere.
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
    // A completed automation command releases its bootstrap lease, which cannot retain the guest.
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

    // Positive control: looking at the page must still make this same oracle paintable.
    expect(hostGuestIsPaintable(runtime, true)).toBe(true)
    expect(hostGuestIsPaintable(runtime, false)).toBe(false)
  })
})
