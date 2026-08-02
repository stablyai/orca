import type { ElectronApplication } from '@stablyai/playwright-test'

export type PtyWriteLogEntry = { id: string; data: string }

const PTY_WRITE_SPY_INSTALL_ATTEMPTS = 3
const PTY_WRITE_SPY_INSTALL_RETRY_MS = 150

export async function installTerminalPtyWriteSpy(app: ElectronApplication): Promise<void> {
  for (let attempt = 1; attempt <= PTY_WRITE_SPY_INSTALL_ATTEMPTS; attempt += 1) {
    try {
      await app.evaluate(({ ipcMain }) => {
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
      return
    } catch (error) {
      if (
        attempt === PTY_WRITE_SPY_INSTALL_ATTEMPTS ||
        !isTransientPtyWriteSpyInstallError(error)
      ) {
        throw error
      }
      // Why: Electron can recreate the evaluated main-world context during
      // startup; retry keeps setup deterministic without hiding real failures.
      await waitForPtyWriteSpyInstallRetry()
    }
  }
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

function isTransientPtyWriteSpyInstallError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Execution context was destroyed')
}

function waitForPtyWriteSpyInstallRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, PTY_WRITE_SPY_INSTALL_RETRY_MS))
}
