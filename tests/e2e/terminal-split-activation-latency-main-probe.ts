import type { ElectronApplication } from '@stablyai/playwright-test'
import type { SplitLatencyMainProbeEvent } from './terminal-split-activation-latency-phases'

type MainProbeInvokeHandler = (event: unknown, args: Record<string, unknown>) => unknown

type SplitLatencyMainProbeState = {
  events: SplitLatencyMainProbeEvent[]
  nextOperationId: number
  cwdHandler: MainProbeInvokeHandler
  spawnHandler: MainProbeInvokeHandler
  writeAcceptedHandler: MainProbeInvokeHandler
  originalCwdHandler: MainProbeInvokeHandler
  originalSpawnHandler: MainProbeInvokeHandler
  originalWriteAcceptedHandler: MainProbeInvokeHandler
  writeListener: (event: unknown, args: { id?: unknown; data?: unknown }) => void
}

export async function installSplitLatencyMainProbe(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const scope = globalThis as typeof globalThis & {
      __terminalSplitLatencyMainProbe?: SplitLatencyMainProbeState
    }
    if (scope.__terminalSplitLatencyMainProbe) {
      throw new Error('Terminal split latency main probe is already installed')
    }
    const handlers = (
      ipcMain as unknown as { _invokeHandlers?: Map<string, MainProbeInvokeHandler> }
    )._invokeHandlers
    const originalCwdHandler = handlers?.get('pty:getCwd')
    const originalSpawnHandler = handlers?.get('pty:spawn')
    const originalWriteAcceptedHandler = handlers?.get('pty:writeAccepted')
    if (
      !handlers ||
      !originalCwdHandler ||
      !originalSpawnHandler ||
      !originalWriteAcceptedHandler
    ) {
      throw new Error('Terminal split latency main probe could not find PTY invoke handlers')
    }
    const state = {
      events: [],
      nextOperationId: 1,
      originalCwdHandler,
      originalSpawnHandler,
      originalWriteAcceptedHandler
    } as unknown as SplitLatencyMainProbeState
    state.cwdHandler = async (event, args) => {
      const operationId = state.nextOperationId++
      const ptyId = typeof args?.id === 'string' ? args.id : null
      state.events.push({
        kind: 'cwd-request',
        operationId,
        atEpochMs: Date.now(),
        ptyId,
        writeChannel: null
      })
      try {
        return await state.originalCwdHandler(event, args)
      } finally {
        state.events.push({
          kind: 'cwd-settled',
          operationId,
          atEpochMs: Date.now(),
          ptyId,
          writeChannel: null
        })
      }
    }
    state.spawnHandler = async (event, args) => {
      const operationId = state.nextOperationId++
      state.events.push({
        kind: 'pty-spawn-request',
        operationId,
        atEpochMs: Date.now(),
        ptyId: null,
        writeChannel: null
      })
      try {
        const result = await state.originalSpawnHandler(event, args)
        const ptyId =
          result && typeof result === 'object' && 'id' in result && typeof result.id === 'string'
            ? result.id
            : null
        state.events.push({
          kind: 'pty-spawn-result',
          operationId,
          atEpochMs: Date.now(),
          ptyId,
          writeChannel: null
        })
        return result
      } catch (error) {
        state.events.push({
          kind: 'pty-spawn-result',
          operationId,
          atEpochMs: Date.now(),
          ptyId: null,
          writeChannel: null
        })
        throw error
      }
    }
    state.writeListener = (_event, args) => {
      if (args?.data !== '\r') {
        return
      }
      state.events.push({
        kind: 'pty-write-cr',
        operationId: null,
        atEpochMs: Date.now(),
        ptyId: typeof args.id === 'string' ? args.id : null,
        writeChannel: 'pty:write'
      })
    }
    state.writeAcceptedHandler = (event, args) => {
      if (args?.data === '\r') {
        state.events.push({
          kind: 'pty-write-cr',
          operationId: null,
          atEpochMs: Date.now(),
          ptyId: typeof args.id === 'string' ? args.id : null,
          writeChannel: 'pty:writeAccepted'
        })
      }
      return state.originalWriteAcceptedHandler(event, args)
    }
    handlers.set('pty:getCwd', state.cwdHandler)
    handlers.set('pty:spawn', state.spawnHandler)
    handlers.set('pty:writeAccepted', state.writeAcceptedHandler)
    ipcMain.prependListener('pty:write', state.writeListener)
    scope.__terminalSplitLatencyMainProbe = state
  })
}

export async function resetSplitLatencyMainProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __terminalSplitLatencyMainProbe?: SplitLatencyMainProbeState
      }
    ).__terminalSplitLatencyMainProbe
    if (!state) {
      throw new Error('Terminal split latency main probe is not installed')
    }
    state.events.length = 0
  })
}

export async function readSplitLatencyMainProbe(
  electronApp: ElectronApplication
): Promise<SplitLatencyMainProbeEvent[]> {
  return electronApp.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __terminalSplitLatencyMainProbe?: SplitLatencyMainProbeState
      }
    ).__terminalSplitLatencyMainProbe
    if (!state) {
      throw new Error('Terminal split latency main probe is not installed')
    }
    return [...state.events]
  })
}

export async function disposeSplitLatencyMainProbe(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const scope = globalThis as typeof globalThis & {
      __terminalSplitLatencyMainProbe?: SplitLatencyMainProbeState
    }
    const state = scope.__terminalSplitLatencyMainProbe
    if (!state) {
      return
    }
    const handlers = (
      ipcMain as unknown as { _invokeHandlers?: Map<string, MainProbeInvokeHandler> }
    )._invokeHandlers
    if (handlers?.get('pty:getCwd') === state.cwdHandler) {
      handlers.set('pty:getCwd', state.originalCwdHandler)
    }
    if (handlers?.get('pty:spawn') === state.spawnHandler) {
      handlers.set('pty:spawn', state.originalSpawnHandler)
    }
    if (handlers?.get('pty:writeAccepted') === state.writeAcceptedHandler) {
      handlers.set('pty:writeAccepted', state.originalWriteAcceptedHandler)
    }
    ipcMain.removeListener('pty:write', state.writeListener)
    delete scope.__terminalSplitLatencyMainProbe
  })
}
