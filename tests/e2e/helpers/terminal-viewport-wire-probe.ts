import type { ElectronApplication } from '@stablyai/playwright-test'

export type TerminalWireFrame = {
  direction: 'in' | 'out'
  opcode?: number
  originalOpcode?: number
  payload?: unknown
  held?: boolean
  streamId?: number
}

type WireProbeState = {
  cleanup: () => void
  held: {
    args: unknown[]
    channel: string
    send: (channel: string, ...args: unknown[]) => void
  }[]
  release: () => void
  trace: TerminalWireFrame[]
}

export async function installTerminalWireProbe(
  app: ElectronApplication,
  options: {
    holdFitEvents?: boolean
    holdHostFitEvents?: boolean
    dropHostViewportClaims?: boolean
    legacyViewportClient?: boolean
  } = {}
): Promise<void> {
  await app.evaluate(({ BrowserWindow, ipcMain }, probeOptions) => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    target.__sta5050WireProbe?.cleanup()
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) {
      throw new Error('Electron window unavailable')
    }
    const trace: TerminalWireFrame[] = []
    const listener = (_event: unknown, message: { bytes?: Uint8Array }) => {
      const bytes = message.bytes
      if (!bytes || bytes.byteLength < 16) {
        return
      }
      const streamId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        4,
        true
      )
      const opcode = bytes[2]
      if (probeOptions.legacyViewportClient && opcode === 9) {
        const text = new TextDecoder().decode(bytes.slice(16))
        const key = 'desktopViewportClaims'
        const offset = text.indexOf(key)
        if (offset !== -1) {
          bytes[16 + offset + key.length - 1] = 'x'.charCodeAt(0)
        }
      }
      if (probeOptions.legacyViewportClient && opcode === 14) {
        // Why: reconstruct the wire shape of an intentionally old client without running an obsolete desktop build.
        bytes[2] = 8
      }
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes.slice(16)))
      } catch {
        payload = bytes[2] === 7 ? new TextDecoder().decode(bytes.slice(16)) : undefined
      }
      trace.push({ direction: 'out', opcode: bytes[2], originalOpcode: opcode, payload, streamId })
    }
    ipcMain.prependListener('runtimeEnvironments:subscriptionBinary', listener)
    const originalEmit = ipcMain.emit
    ipcMain.emit = ((channel: string, ...args: unknown[]) => {
      if (probeOptions.dropHostViewportClaims && channel === 'pty:claimViewport') {
        trace.push({ direction: 'out', opcode: 14, payload: args.at(-1) })
        return true
      }
      return originalEmit.call(ipcMain, channel, ...args)
    }) as typeof ipcMain.emit
    const held: WireProbeState['held'] = []
    const sendPrototype = Object.getPrototypeOf(windows[0].webContents) as {
      send: (channel: string, ...args: unknown[]) => void
    }
    const originalSend = sendPrototype.send
    sendPrototype.send = function (this: unknown, channel: string, ...args: unknown[]) {
      const send = (nextChannel: string, ...nextArgs: unknown[]) =>
        originalSend.call(this, nextChannel, ...nextArgs)
      const isRemoteFit =
        channel === 'runtimeEnvironments:subscriptionEvent' &&
        JSON.stringify(args).includes('fit-override-changed')
      const isHostFit = channel === 'runtime:terminalFitOverrideChanged'
      const shouldHold =
        (isRemoteFit && probeOptions.holdFitEvents) || (isHostFit && probeOptions.holdHostFitEvents)
      if (isRemoteFit || isHostFit) {
        trace.push({ direction: 'in', held: Boolean(shouldHold), payload: args })
      }
      if (shouldHold) {
        held.push({ channel, args, send })
        return
      }
      send(channel, ...args)
    }
    const release = () => {
      for (const event of held.splice(0)) {
        event.send(event.channel, ...event.args)
      }
    }
    const cleanup = () => {
      release()
      ipcMain.removeListener('runtimeEnvironments:subscriptionBinary', listener)
      ipcMain.emit = originalEmit
      sendPrototype.send = originalSend
      delete target.__sta5050WireProbe
    }
    target.__sta5050WireProbe = { cleanup, held, release, trace }
  }, options)
}

export async function readTerminalWireProbe(
  app: ElectronApplication
): Promise<TerminalWireFrame[]> {
  return app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    return target.__sta5050WireProbe?.trace ?? []
  })
}

export async function releaseTerminalFitEvents(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    target.__sta5050WireProbe?.release()
  })
}

export async function disposeTerminalWireProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const target = globalThis as typeof globalThis & { __sta5050WireProbe?: WireProbeState }
    target.__sta5050WireProbe?.cleanup()
  })
}
