import type { ElectronApplication } from '@stablyai/playwright-test'

/**
 * Records what Chromium itself delivers, before the page sees it. The renderer probe can only say
 * "no keyup arrived here"; this says whether one arrived at all, which separates a release lost at
 * the OS boundary from one consumed inside the app.
 */

export type MainProcessInputRow = {
  t: string
  key: string
  code: string
  meta: boolean
  alt: boolean
  control: boolean
  shift: boolean
  isAutoRepeat: boolean
  /** Read after Orca's own handler ran, since this listener registers last. */
  defaultPrevented: boolean
  ts: number
}

export async function installMainProcessInputProbe(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    type ProbeGlobal = typeof globalThis & {
      __mainInputProbe?: { rows: unknown[]; dispose: () => void }
    }
    const probeGlobal = globalThis as ProbeGlobal
    probeGlobal.__mainInputProbe?.dispose()

    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) {
      throw new Error('No BrowserWindow available')
    }
    const rows: unknown[] = []
    const listener = (event: { defaultPrevented?: boolean }, input: Electron.Input): void => {
      rows.push({
        t: input.type,
        key: input.key,
        code: input.code,
        meta: input.meta,
        alt: input.alt,
        control: input.control,
        shift: input.shift,
        isAutoRepeat: input.isAutoRepeat,
        defaultPrevented: event.defaultPrevented === true,
        ts: Date.now()
      })
    }
    mainWindow.webContents.on('before-input-event', listener)
    probeGlobal.__mainInputProbe = {
      rows,
      dispose: () => mainWindow.webContents.off('before-input-event', listener)
    }
  })
}

export async function readMainProcessInputProbe(
  electronApp: ElectronApplication
): Promise<MainProcessInputRow[]> {
  const rows = await electronApp.evaluate(() => {
    const probe = (globalThis as typeof globalThis & { __mainInputProbe?: { rows: unknown[] } })
      .__mainInputProbe
    if (!probe) {
      throw new Error('main-process input probe was never installed')
    }
    return [...probe.rows]
  })
  return rows as MainProcessInputRow[]
}

export async function disposeMainProcessInputProbe(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(() => {
    const probeGlobal = globalThis as typeof globalThis & {
      __mainInputProbe?: { dispose: () => void }
    }
    probeGlobal.__mainInputProbe?.dispose()
    probeGlobal.__mainInputProbe = undefined
  })
}
