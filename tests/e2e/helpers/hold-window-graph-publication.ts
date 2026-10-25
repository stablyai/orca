import type { ElectronApplication } from '@stablyai/playwright-test'
import type { IpcMainInvokeEvent } from 'electron'

const GRAPH_CHANNEL = 'runtime:syncWindowGraph'

type GraphPublicationGate = { held: boolean; published: number }

declare global {
  var __e2eGraphPublicationGate: GraphPublicationGate | undefined
}

// Hold initial renderer graph publication so paired calls deterministically reach an accepting host with no published tabs.
export async function holdWindowGraphPublication(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    const gate: GraphPublicationGate = { held: true, published: 0 }
    globalThis.__e2eGraphPublicationGate = gate
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    const wrap =
      (handler: Handler): Handler =>
      async (event, ...args) => {
        while (gate.held) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const result = await handler(event, ...args)
        gate.published += 1
        return result
      }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron keeps invoke handlers in this private map; absence leaves only the later-registration patch.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, Handler> })
      ._invokeHandlers
    const existing = handlers?.get(channel)
    if (handlers && existing) {
      handlers.set(channel, wrap(existing))
    }
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (name, listener) => handle(name, name === channel ? wrap(listener) : listener)
  }, GRAPH_CHANNEL)
}

// Require zero publications before release to prove earlier calls saw no renderer graph.
export async function releaseWindowGraphPublication(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    const gate = globalThis.__e2eGraphPublicationGate
    if (!gate) {
      throw new Error('window graph publication was never held')
    }
    gate.held = false
    return gate.published
  })
}
