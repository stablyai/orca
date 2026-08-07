import { describe, expect, it } from 'vitest'
import { resolveSidebarSlotChrome, resolveSidebarSlotLayout } from './sidebar-slot-layout'

const CHROME_BASE = {
  leftOccupant: 'workspace',
  workspaceSidebarOpen: true,
  activitySidebarOpen: true,
  leftTitlebarChromeMounted: true,
  stackedSidebarOpen: false
} as const

describe('resolveSidebarSlotLayout', () => {
  it('keeps the workspace list on the left by default', () => {
    expect(
      resolveSidebarSlotLayout({
        workspaceSidebarPosition: 'left',
        platform: 'darwin',
        isWebClient: false
      })
    ).toEqual({
      leftOccupant: 'workspace',
      rightOccupant: 'activity',
      windowControlsEdge: 'left',
      windowControlsOccupant: 'workspace'
    })
  })

  it('swaps both occupants when the workspace list moves right', () => {
    const layout = resolveSidebarSlotLayout({
      workspaceSidebarPosition: 'right',
      platform: 'darwin',
      isWebClient: false
    })
    expect(layout.leftOccupant).toBe('activity')
    expect(layout.rightOccupant).toBe('workspace')
  })

  it('charges the macOS traffic-light inset to whichever sidebar holds the left edge', () => {
    expect(
      resolveSidebarSlotLayout({
        workspaceSidebarPosition: 'right',
        platform: 'darwin',
        isWebClient: false
      }).windowControlsOccupant
    ).toBe('activity')
  })

  it('charges the custom-chrome inset to the right edge on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(
        resolveSidebarSlotLayout({
          workspaceSidebarPosition: 'left',
          platform,
          isWebClient: false
        })
      ).toMatchObject({ windowControlsEdge: 'right', windowControlsOccupant: 'activity' })
      // Why: the same edge stays crowded, so swapping hands the inset to the workspace list.
      expect(
        resolveSidebarSlotLayout({
          workspaceSidebarPosition: 'right',
          platform,
          isWebClient: false
        }).windowControlsOccupant
      ).toBe('workspace')
    }
  })

  it('drops window-control insets in the web client, which draws no OS controls', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(
        resolveSidebarSlotLayout({
          workspaceSidebarPosition: 'left',
          platform,
          isWebClient: true
        })
      ).toMatchObject({ windowControlsEdge: null, windowControlsOccupant: null })
    }
  })
})

describe('resolveSidebarSlotChrome', () => {
  it('reads the left slot from the workspace list while it holds that edge', () => {
    expect(resolveSidebarSlotChrome({ ...CHROME_BASE, workspaceSidebarOpen: false })).toMatchObject(
      { leftSlotOpen: false, trailingSlotOpen: true }
    )
  })

  it('reads the left slot from the activity sidebar once the lists swap', () => {
    // Why: the regression this guards — the collapsed left slot kept reporting the workspace
    // list's state, so a left-mounted activity sidebar never released its column.
    expect(
      resolveSidebarSlotChrome({
        ...CHROME_BASE,
        leftOccupant: 'activity',
        activitySidebarOpen: false
      })
    ).toMatchObject({ leftSlotOpen: false, trailingSlotOpen: true })
  })

  it('leaves the left slot open when only the trailing sidebar collapses', () => {
    for (const leftOccupant of ['workspace', 'activity'] as const) {
      const trailingClosed =
        leftOccupant === 'workspace'
          ? { activitySidebarOpen: false }
          : { workspaceSidebarOpen: false }
      expect(
        resolveSidebarSlotChrome({ ...CHROME_BASE, leftOccupant, ...trailingClosed })
      ).toMatchObject({
        leftSlotOpen: true,
        trailingSlotOpen: false,
        leftColumnHeaderFloating: false
      })
    }
  })

  it('floats the left header only when its own slot collapsed under mounted chrome', () => {
    expect(
      resolveSidebarSlotChrome({ ...CHROME_BASE, workspaceSidebarOpen: false })
        .leftColumnHeaderFloating
    ).toBe(true)
    expect(resolveSidebarSlotChrome(CHROME_BASE).leftColumnHeaderFloating).toBe(false)
  })

  it('keeps the header in flow when the left column draws no titlebar chrome', () => {
    expect(
      resolveSidebarSlotChrome({
        ...CHROME_BASE,
        workspaceSidebarOpen: false,
        leftTitlebarChromeMounted: false
      }).leftColumnHeaderFloating
    ).toBe(false)
  })

  it('keeps the header in flow in stacked views, which draw their own full-width titlebar', () => {
    expect(
      resolveSidebarSlotChrome({
        ...CHROME_BASE,
        workspaceSidebarOpen: false,
        stackedSidebarOpen: true
      }).leftColumnHeaderFloating
    ).toBe(false)
  })
})
