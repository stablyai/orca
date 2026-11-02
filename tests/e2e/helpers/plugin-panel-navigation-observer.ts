import type { ElectronApplication } from '@stablyai/playwright-test'
import type { Event as ElectronEvent, WebContentsWillFrameNavigateEventParams } from 'electron'

export type PanelNavigationObservation = {
  willFrameNavigations: { defaultPrevented: boolean; isMainFrame: boolean; url: string }[]
  didFrameNavigations: { isMainFrame: boolean; url: string }[]
  externalUrls: string[]
}

type MainPanelNavigationProbe = {
  dispose: () => void
  observation: PanelNavigationObservation
}

export async function startPanelNavigationObserver(
  electronApp: ElectronApplication,
  pageUrl: string
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, shell }, expectedUrl) => {
    const browserWindow =
      BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === expectedUrl
      ) ?? BrowserWindow.getAllWindows()[0]
    if (!browserWindow) {
      throw new Error('main window unavailable for panel navigation observer')
    }
    const contents = browserWindow.webContents
    const observation: PanelNavigationObservation = {
      willFrameNavigations: [],
      didFrameNavigations: [],
      externalUrls: []
    }
    const onWillFrameNavigate = (
      event: ElectronEvent<WebContentsWillFrameNavigateEventParams>
    ): void => {
      observation.willFrameNavigations.push({
        defaultPrevented: event.defaultPrevented,
        isMainFrame: event.isMainFrame,
        url: event.url
      })
    }
    const onDidFrameNavigate = (
      _event: ElectronEvent,
      url: string,
      _httpResponseCode: number,
      _httpStatusText: string,
      isMainFrame: boolean
    ): void => {
      observation.didFrameNavigations.push({ isMainFrame, url })
    }
    const probeGlobal = globalThis as typeof globalThis & {
      __orcaPanelNavigationProbe?: MainPanelNavigationProbe
    }
    probeGlobal.__orcaPanelNavigationProbe?.dispose()
    const originalOpenExternal = shell.openExternal
    const recordOpenExternal = async (url: string): Promise<void> => {
      observation.externalUrls.push(url)
    }
    contents.on('will-frame-navigate', onWillFrameNavigate)
    contents.on('did-frame-navigate', onDidFrameNavigate)
    shell.openExternal = recordOpenExternal

    probeGlobal.__orcaPanelNavigationProbe = {
      observation,
      dispose: () => {
        contents.off('will-frame-navigate', onWillFrameNavigate)
        contents.off('did-frame-navigate', onDidFrameNavigate)
        if (shell.openExternal === recordOpenExternal) {
          shell.openExternal = originalOpenExternal
        }
      }
    }
  }, pageUrl)
}

export async function readPanelNavigationObserver(
  electronApp: ElectronApplication
): Promise<PanelNavigationObservation> {
  return electronApp.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        __orcaPanelNavigationProbe?: MainPanelNavigationProbe
      }
    ).__orcaPanelNavigationProbe
    if (!probe) {
      throw new Error('panel navigation observer is not active')
    }
    return structuredClone(probe.observation)
  })
}

export async function stopPanelNavigationObserver(
  electronApp: ElectronApplication
): Promise<PanelNavigationObservation> {
  return electronApp.evaluate(() => {
    const probeGlobal = globalThis as typeof globalThis & {
      __orcaPanelNavigationProbe?: MainPanelNavigationProbe
    }
    const probe = probeGlobal.__orcaPanelNavigationProbe
    if (!probe) {
      throw new Error('panel navigation observer is not active')
    }
    const observation = structuredClone(probe.observation)
    probe.dispose()
    delete probeGlobal.__orcaPanelNavigationProbe
    return observation
  })
}
