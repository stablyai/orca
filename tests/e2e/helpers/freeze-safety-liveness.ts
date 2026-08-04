import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { WebSocket, WebSocketServer } from 'ws'

const MAIN_WATCH_KEY = '__orcaFreezeSafetyMainWatch'
const RENDERER_WATCH_KEY = '__orcaFreezeSafetyRendererWatch'
const DEFAULT_INTERVAL_MS = 100
const READY_TIMEOUT_MS = 10_000

type MainWatchState = {
  timer: ReturnType<typeof setInterval>
  lastTickMs: number
  maxTimerLatenessMs: number
  ticks: number
}

type RendererWatchState = {
  epoch: number
  ipcPending: boolean
  ipcTimer: number
  socket: { close: () => void }
}

export type FreezeSafetyLivenessReport = {
  mainLoop: { maxTimerLatenessMs: number; ticks: number }
  rendererHeartbeat: { maxRoundTripMs: number; roundTrips: number }
  unrelatedIpc: { failures: number; maxRoundTripMs: number; roundTrips: number }
}

export type FreezeSafetyLivenessWatch = {
  sample: () => Promise<FreezeSafetyLivenessReport>
  stop: () => Promise<void>
}

type WireMessage =
  | { type: 'ipc'; epoch: number; ms: number; ok: boolean }
  | { type: 'ping'; id: number }
  | { type: 'pong'; id: number }

function max(values: number[]): number {
  return values.reduce((current, value) => Math.max(current, value), 0)
}

async function installMainLoopWatch(
  electronApp: ElectronApplication,
  intervalMs: number
): Promise<void> {
  await electronApp.evaluate(
    (_electron, args) => {
      const scope = globalThis as unknown as Record<string, unknown>
      const previous = scope[args.key] as MainWatchState | undefined
      if (previous) {
        clearInterval(previous.timer)
      }
      const state: MainWatchState = {
        timer: 0 as unknown as ReturnType<typeof setInterval>,
        lastTickMs: Date.now(),
        maxTimerLatenessMs: 0,
        ticks: 0
      }
      state.timer = setInterval(() => {
        const now = Date.now()
        state.maxTimerLatenessMs = Math.max(
          state.maxTimerLatenessMs,
          now - state.lastTickMs - args.intervalMs
        )
        state.lastTickMs = now
        state.ticks += 1
      }, args.intervalMs)
      state.timer.unref?.()
      scope[args.key] = state
    },
    { intervalMs, key: MAIN_WATCH_KEY }
  )
}

async function resetMainLoopWatch(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate((_electron, key) => {
    const state = (globalThis as unknown as Record<string, unknown>)[key] as MainWatchState
    state.lastTickMs = Date.now()
    state.maxTimerLatenessMs = 0
    state.ticks = 0
  }, MAIN_WATCH_KEY)
}

async function readMainLoopWatch(
  electronApp: ElectronApplication
): Promise<FreezeSafetyLivenessReport['mainLoop']> {
  return electronApp.evaluate((_electron, key) => {
    const state = (globalThis as unknown as Record<string, unknown>)[key] as MainWatchState
    return { maxTimerLatenessMs: state.maxTimerLatenessMs, ticks: state.ticks }
  }, MAIN_WATCH_KEY)
}

async function removeMainLoopWatch(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate((_electron, key) => {
    const scope = globalThis as unknown as Record<string, unknown>
    const state = scope[key] as MainWatchState | undefined
    if (state) {
      clearInterval(state.timer)
      delete scope[key]
    }
  }, MAIN_WATCH_KEY)
}

async function installRendererWatch(page: Page, port: number, intervalMs: number): Promise<void> {
  await page.evaluate(
    ({ key, socketPort, tickMs }) => {
      const scope = window as unknown as Record<string, unknown>
      const previous = scope[key] as RendererWatchState | undefined
      if (previous) {
        window.clearInterval(previous.ipcTimer)
        previous.socket.close()
      }
      const socket = new window.WebSocket(`ws://127.0.0.1:${socketPort}`)
      const state: RendererWatchState = { epoch: 0, ipcPending: false, ipcTimer: 0, socket }
      const send = (message: WireMessage): void => {
        if (socket.readyState === window.WebSocket.OPEN) {
          socket.send(JSON.stringify(message))
        }
      }
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as WireMessage
        if (message.type === 'ping') {
          send({ type: 'pong', id: message.id })
        }
      })
      state.ipcTimer = window.setInterval(() => {
        if (state.ipcPending || socket.readyState !== window.WebSocket.OPEN) {
          return
        }
        state.ipcPending = true
        const startedAt = performance.now()
        const epoch = state.epoch
        void window.api.app
          .getIdentity()
          .then(() => {
            send({
              type: 'ipc',
              epoch,
              ms: performance.now() - startedAt,
              ok: true
            })
          })
          .catch(() => {
            send({
              type: 'ipc',
              epoch,
              ms: performance.now() - startedAt,
              ok: false
            })
          })
          .finally(() => {
            state.ipcPending = false
          })
      }, tickMs)
      scope[key] = state
    },
    { key: RENDERER_WATCH_KEY, socketPort: port, tickMs: intervalMs }
  )
}

async function setRendererEpoch(page: Page, epoch: number): Promise<void> {
  await page.evaluate(
    ({ key, value }) => {
      const state = (window as unknown as Record<string, unknown>)[key] as RendererWatchState
      state.epoch = value
    },
    { key: RENDERER_WATCH_KEY, value: epoch }
  )
}

async function removeRendererWatch(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const scope = window as unknown as Record<string, unknown>
    const state = scope[key] as RendererWatchState | undefined
    if (state) {
      window.clearInterval(state.ipcTimer)
      state.socket.close()
      delete scope[key]
    }
  }, RENDERER_WATCH_KEY)
}

async function waitUntilReady(rendererRtts: number[], ipcRtts: number[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (rendererRtts.length >= 3 && ipcRtts.length >= 3) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Freeze-safety liveness channels did not become ready')
}

export async function watchFreezeSafetyLiveness(
  electronApp: ElectronApplication,
  page: Page,
  intervalMs = DEFAULT_INTERVAL_MS
): Promise<FreezeSafetyLivenessWatch> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const rendererRtts: number[] = []
  const ipcRtts: number[] = []
  let ipcFailures = 0
  let epoch = 0
  let nextPingId = 1
  const sentPings = new Map<number, number>()

  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as WireMessage
      if (message.type === 'pong') {
        const sentAt = sentPings.get(message.id)
        if (sentAt !== undefined) {
          rendererRtts.push(Date.now() - sentAt)
          sentPings.delete(message.id)
        }
      } else if (message.type === 'ipc' && message.epoch === epoch) {
        ipcRtts.push(message.ms)
        ipcFailures += message.ok ? 0 : 1
      }
    })
  })

  const pingTimer = setInterval(() => {
    for (const socket of server.clients) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue
      }
      const id = nextPingId++
      sentPings.set(id, Date.now())
      socket.send(JSON.stringify({ type: 'ping', id } satisfies WireMessage))
    }
  }, intervalMs)
  pingTimer.unref?.()

  try {
    await installMainLoopWatch(electronApp, intervalMs)
    const address = server.address() as AddressInfo
    await installRendererWatch(page, address.port, intervalMs)
    await waitUntilReady(rendererRtts, ipcRtts)
    epoch += 1
    rendererRtts.length = 0
    ipcRtts.length = 0
    ipcFailures = 0
    sentPings.clear()
    await setRendererEpoch(page, epoch)
    await resetMainLoopWatch(electronApp)
  } catch (error) {
    clearInterval(pingTimer)
    await Promise.allSettled([removeRendererWatch(page), removeMainLoopWatch(electronApp)])
    for (const socket of server.clients) {
      socket.terminate()
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }

  let stopped = false
  return {
    sample: async () => ({
      mainLoop: await readMainLoopWatch(electronApp),
      rendererHeartbeat: {
        maxRoundTripMs: max(rendererRtts),
        roundTrips: rendererRtts.length
      },
      unrelatedIpc: {
        failures: ipcFailures,
        maxRoundTripMs: max(ipcRtts),
        roundTrips: ipcRtts.length
      }
    }),
    stop: async () => {
      if (stopped) {
        return
      }
      stopped = true
      clearInterval(pingTimer)
      await Promise.allSettled([removeRendererWatch(page), removeMainLoopWatch(electronApp)])
      for (const socket of server.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
