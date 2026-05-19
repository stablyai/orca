import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type RightSidebarHeaderGeometry = {
  controlsLeft: number
  stripRight: number
  closeRight: number
  stripScrollWidth: number
  stripClientWidth: number
  firstButtonCenterHitsFirst: boolean
}

type ScrolledActivityButtonGeometry = {
  controlsLeft: number
  lastButtonRight: number
  lastButtonCenterHitsLast: boolean
}

test.describe('Right sidebar Windows titlebar spacing', () => {
  test('top activity buttons stay reachable when the right sidebar is narrowed', async ({
    orcaPage
  }) => {
    await orcaPage.addInitScript(() => {
      const userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36'
      Object.defineProperty(navigator, 'userAgent', {
        get: () => userAgent,
        configurable: true
      })
    })
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => ({
            hasWindowsUserAgent: navigator.userAgent.includes('Windows'),
            hasWindowsTitlebarChrome: Boolean(document.querySelector('.window-controls'))
          })),
        {
          timeout: 5_000,
          message: 'Renderer did not switch to the Windows titlebar branch'
        }
      )
      .toEqual({ hasWindowsUserAgent: true, hasWindowsTitlebarChrome: true })

    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available - is the app in dev mode?')
      }

      store.setState({
        activityBarPosition: 'top',
        rightSidebarOpen: true,
        rightSidebarWidth: 220
      })
    })

    const measureHeader = async (): Promise<RightSidebarHeaderGeometry | null> =>
      orcaPage.evaluate(() => {
        const controls = document.querySelector<HTMLElement>('.window-controls')
        const header = document.querySelector<HTMLElement>('.right-sidebar-header-inset')
        const strip = header?.querySelector<HTMLElement>('.right-sidebar-activity-strip') ?? null
        const closeButton =
          header?.querySelector<HTMLButtonElement>('button[aria-label="Toggle right sidebar"]') ??
          null
        const activityButtons = Array.from(
          header?.querySelectorAll<HTMLButtonElement>(
            'button[aria-label]:not([aria-label="Toggle right sidebar"])'
          ) ?? []
        )
        const firstButton = activityButtons[0]

        if (!controls || !header || !strip || !closeButton || !firstButton) {
          return null
        }

        const controlsRect = controls.getBoundingClientRect()
        const stripRect = strip.getBoundingClientRect()
        const closeRect = closeButton.getBoundingClientRect()
        const firstRect = firstButton.getBoundingClientRect()
        const firstCenterX = firstRect.left + firstRect.width / 2
        const firstCenterY = firstRect.top + firstRect.height / 2
        const elementAtFirstCenter = document.elementFromPoint(firstCenterX, firstCenterY)

        return {
          controlsLeft: controlsRect.left,
          stripRight: stripRect.right,
          closeRight: closeRect.right,
          stripScrollWidth: strip.scrollWidth,
          stripClientWidth: strip.clientWidth,
          firstButtonCenterHitsFirst:
            elementAtFirstCenter !== null && firstButton.contains(elementAtFirstCenter)
        }
      })

    let headerGeometry: RightSidebarHeaderGeometry | null = null
    await expect
      .poll(
        async () => {
          headerGeometry = await measureHeader()
          return headerGeometry !== null && headerGeometry.stripClientWidth > 0
        },
        {
          timeout: 5_000,
          message: 'Right sidebar header never reached a measurable narrowed state'
        }
      )
      .toBe(true)

    expect(headerGeometry).not.toBeNull()
    expect(headerGeometry!.stripRight).toBeLessThanOrEqual(headerGeometry!.controlsLeft)
    expect(headerGeometry!.closeRight).toBeLessThanOrEqual(headerGeometry!.controlsLeft)
    expect(headerGeometry!.stripScrollWidth).toBeGreaterThan(headerGeometry!.stripClientWidth)
    expect(headerGeometry!.firstButtonCenterHitsFirst).toBe(true)

    await orcaPage.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('.right-sidebar-activity-strip')
      if (!strip) {
        throw new Error('Right sidebar activity strip is missing')
      }
      strip.scrollLeft = strip.scrollWidth
    })
    // Why: hidden Electron e2e windows can throttle requestAnimationFrame for a
    // long time; scrollLeft is synchronous, so a short Playwright-side delay is
    // enough to let layout settle without depending on renderer frame cadence.
    await orcaPage.waitForTimeout(50)

    const scrolledGeometry = await orcaPage.evaluate((): ScrolledActivityButtonGeometry | null => {
      const controls = document.querySelector<HTMLElement>('.window-controls')
      const header = document.querySelector<HTMLElement>('.right-sidebar-header-inset')
      const activityButtons = Array.from(
        header?.querySelectorAll<HTMLButtonElement>(
          'button[aria-label]:not([aria-label="Toggle right sidebar"])'
        ) ?? []
      )
      const lastButton = activityButtons.at(-1)

      if (!controls || !lastButton) {
        return null
      }

      const controlsRect = controls.getBoundingClientRect()
      const lastRect = lastButton.getBoundingClientRect()
      const lastCenterX = lastRect.left + lastRect.width / 2
      const lastCenterY = lastRect.top + lastRect.height / 2
      const elementAtLastCenter = document.elementFromPoint(lastCenterX, lastCenterY)

      return {
        controlsLeft: controlsRect.left,
        lastButtonRight: lastRect.right,
        lastButtonCenterHitsLast:
          elementAtLastCenter !== null && lastButton.contains(elementAtLastCenter)
      }
    })

    expect(scrolledGeometry).not.toBeNull()
    expect(scrolledGeometry!.lastButtonRight).toBeLessThanOrEqual(scrolledGeometry!.controlsLeft)
    expect(scrolledGeometry!.lastButtonCenterHitsLast).toBe(true)
  })
})
