import type { ElectronApplication } from '@stablyai/playwright-test'

import { retryTransientMainEvaluate } from './electron-main-evaluate-retry'

export type PtyWriteLogEntry = { id: string; data: string }

export async function installTerminalPtyWriteSpy(app: ElectronApplication): Promise<void> {
  await retryTransientMainEvaluate(() =>
    app.evaluate(({ ipcMain }) => {
      const global = globalThis as unknown as {
        __terminalPtyWriteLog?: PtyWriteLogEntry[]
        __terminalPtyWriteSpyInstalled?: boolean
        __terminalPtyWriteAcceptedSpyInstalled?: boolean
        __terminalPtyWriteDelayMs?: number
      }
      if (global.__terminalPtyWriteSpyInstalled) {
        return
      }
      global.__terminalPtyWriteLog = []
      global.__terminalPtyWriteSpyInstalled = true
      ipcMain.prependListener('pty:write', (_event: unknown, args: PtyWriteLogEntry) => {
        global.__terminalPtyWriteLog!.push({ id: args.id, data: args.data })
      })

      // Playwright cannot observe ipcRenderer.invoke payloads, so this e2e spy wraps main's handler.
      const invokeHandlers = (
        ipcMain as unknown as {
          _invokeHandlers?: Map<string, (event: unknown, args: PtyWriteLogEntry) => unknown>
        }
      )._invokeHandlers
      const writeAcceptedHandler = invokeHandlers?.get('pty:writeAccepted')
      if (!writeAcceptedHandler || global.__terminalPtyWriteAcceptedSpyInstalled) {
        return
      }
      global.__terminalPtyWriteAcceptedSpyInstalled = true
      invokeHandlers?.set('pty:writeAccepted', async (event, args) => {
        global.__terminalPtyWriteLog!.push({ id: args.id, data: args.data })
        const delayMs = Math.max(0, global.__terminalPtyWriteDelayMs ?? 0)
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
        return writeAcceptedHandler(event, args)
      })
    })
  )
}

export async function clearTerminalPtyWriteLog(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const global = globalThis as unknown as { __terminalPtyWriteLog?: PtyWriteLogEntry[] }
    if (global.__terminalPtyWriteLog) {
      global.__terminalPtyWriteLog.length = 0
    }
  })
}

export async function readTerminalPtyWrites(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const global = globalThis as unknown as { __terminalPtyWriteLog?: PtyWriteLogEntry[] }
    return (global.__terminalPtyWriteLog ?? []).map((entry) => entry.data)
  })
}

export async function readTerminalPtyWriteEntries(
  app: ElectronApplication
): Promise<PtyWriteLogEntry[]> {
  return app.evaluate(() => {
    const global = globalThis as unknown as { __terminalPtyWriteLog?: PtyWriteLogEntry[] }
    return [...(global.__terminalPtyWriteLog ?? [])]
  })
}

export async function setTerminalPtyWriteDelay(
  app: ElectronApplication,
  delayMs: number
): Promise<void> {
  await app.evaluate((nextDelayMs) => {
    const global = globalThis as unknown as { __terminalPtyWriteDelayMs?: number }
    global.__terminalPtyWriteDelayMs = Math.max(0, nextDelayMs)
  }, delayMs)
}
