import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type RightSidebarHeaderGeometry = {
  headerBottom: number
  stripTop: number
  closeTop: number
  titlebarActivityButtonCount: number
  firstButtonCenterHitsFirst: boolean
  lastButtonCenterHitsLast: boolean
}

test.describe('Right sidebar Windows titlebar spacing', () => {
  test('top activity buttons render inside the sidebar instead of the titlebar', async ({
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
        const header = document.querySelector<HTMLElement>('.right-sidebar-header-inset')
        const strip = document.querySelector<HTMLElement>('.right-sidebar-activity-strip')
        const closeButton = header?.querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right sidebar"]'
        )
        const titlebarActivityButtonCount =
          header?.querySelectorAll<HTMLButtonElement>(
            'button[aria-label]:not([aria-label="Toggle right sidebar"])'
          ).length ?? 0
        const activityButtons = Array.from(
          strip?.querySelectorAll<HTMLButtonElement>(
            'button[aria-label]:not([aria-label="Toggle right sidebar"])'
          ) ?? []
        )
        const firstButton = activityButtons[0]
        const lastButton = activityButtons.at(-1)

        if (!header || !strip || !closeButton || !firstButton || !lastButton) {
          return null
        }

        const headerRect = header.getBoundingClientRect()
        const stripRect = strip.getBoundingClientRect()
        const closeRect = closeButton.getBoundingClientRect()
        const firstRect = firstButton.getBoundingClientRect()
        const firstCenterX = firstRect.left + firstRect.width / 2
        const firstCenterY = firstRect.top + firstRect.height / 2
        const elementAtFirstCenter = document.elementFromPoint(firstCenterX, firstCenterY)
        const lastRect = lastButton.getBoundingClientRect()
        const lastCenterX = lastRect.left + lastRect.width / 2
        const lastCenterY = lastRect.top + lastRect.height / 2
        const elementAtLastCenter = document.elementFromPoint(lastCenterX, lastCenterY)

        return {
          headerBottom: headerRect.bottom,
          stripTop: stripRect.top,
          closeTop: closeRect.top,
          titlebarActivityButtonCount,
          firstButtonCenterHitsFirst:
            elementAtFirstCenter !== null && firstButton.contains(elementAtFirstCenter),
          lastButtonCenterHitsLast:
            elementAtLastCenter !== null && lastButton.contains(elementAtLastCenter)
        }
      })

    let headerGeometry: RightSidebarHeaderGeometry | null = null
    await expect
      .poll(
        async () => {
          headerGeometry = await measureHeader()
          return headerGeometry !== null
        },
        {
          timeout: 5_000,
          message: 'Right sidebar header never reached a measurable narrowed state'
        }
      )
      .toBe(true)

    expect(headerGeometry).not.toBeNull()
    expect(headerGeometry!.titlebarActivityButtonCount).toBe(0)
    expect(headerGeometry!.stripTop).toBeGreaterThanOrEqual(headerGeometry!.headerBottom)
    expect(headerGeometry!.closeTop).toBeLessThan(headerGeometry!.headerBottom)
    expect(headerGeometry!.firstButtonCenterHitsFirst).toBe(true)
    expect(headerGeometry!.lastButtonCenterHitsLast).toBe(true)
  })
})
