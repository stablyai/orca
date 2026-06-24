import type { Page } from '@stablyai/playwright-test'
import {
  getTerminalContentForPtyId,
  readFocusedTerminalDebug,
  terminalOutputIncludesMarker
} from './helpers/terminal-pty-content'

type TerminalMarkerWatch = {
  deadlineAt: number
  detectedAt: number | null
  observer?: MutationObserver
  restoreWrite?: () => void
  startAt: number
  timer?: number
  writeTail: string
}

type TerminalMarkerWatchWindow = Window & {
  __terminalMarkerWatches?: Record<string, TerminalMarkerWatch>
}

const MARKER_SERIALIZE_FALLBACK_INTERVAL_MS = 50

export async function startTerminalMarkerWatch(
  page: Page,
  ptyId: string,
  marker: string,
  timeoutMs: number,
  watchId: string
): Promise<void> {
  await page.evaluate(
    ({ marker, ptyId: targetPtyId, timeoutMs, watchId }) => {
      const target = window as TerminalMarkerWatchWindow
      target.__terminalMarkerWatches ??= {}
      for (const manager of window.__paneManagers?.values() ?? []) {
        for (const pane of manager.getPanes?.() ?? []) {
          if (pane.container?.dataset?.ptyId !== targetPtyId) {
            continue
          }
          const startAt = performance.now()
          const watch: TerminalMarkerWatch = {
            deadlineAt: startAt + timeoutMs,
            detectedAt: null,
            startAt,
            writeTail: ''
          }
          const finishIfFound = (): void => {
            if (watch.detectedAt === null && pane.container.textContent?.includes(marker)) {
              watch.detectedAt = performance.now()
            }
            if (watch.detectedAt !== null) {
              watch.observer?.disconnect()
              watch.restoreWrite?.()
              if (watch.timer !== undefined) {
                window.clearTimeout(watch.timer)
                delete watch.timer
              }
              delete watch.observer
              delete watch.restoreWrite
            }
          }
          const originalWrite = pane.terminal.write
          const patchedWrite: typeof pane.terminal.write = (data, callback) => {
            if (watch.detectedAt === null && typeof data === 'string') {
              const combined = watch.writeTail + data
              if (combined.includes(marker)) {
                watch.detectedAt = performance.now()
              }
              watch.writeTail = combined.slice(-Math.max(marker.length - 1, 0))
            }
            const result = originalWrite.call(pane.terminal, data, callback)
            finishIfFound()
            return result
          }
          watch.restoreWrite = () => {
            if (pane.terminal.write === patchedWrite) {
              pane.terminal.write = originalWrite
            }
          }
          pane.terminal.write = patchedWrite
          watch.observer = new MutationObserver(finishIfFound)
          watch.timer = window.setTimeout(() => {
            finishIfFound()
            watch.observer?.disconnect()
            watch.restoreWrite?.()
            delete watch.observer
            delete watch.restoreWrite
            delete watch.timer
          }, timeoutMs + 1_000)
          target.__terminalMarkerWatches[watchId] = watch
          finishIfFound()
          if (watch.detectedAt === null) {
            watch.observer.observe(pane.container, {
              characterData: true,
              childList: true,
              subtree: true
            })
          }
          return
        }
      }
      throw new Error(`Terminal marker watch target is unavailable for PTY ${targetPtyId}`)
    },
    { marker, ptyId, timeoutMs, watchId }
  )
}

export async function waitForMarkerLatency<TPressure>(
  page: Page,
  ptyId: string,
  marker: string,
  timeoutMs: number,
  watchId: string,
  readMainPtyPressureDebug: (page: Page) => Promise<TPressure | null>
): Promise<number> {
  const start = performance.now()
  let nextSerializedFallbackAt = start + MARKER_SERIALIZE_FALLBACK_INTERVAL_MS
  while (performance.now() - start < timeoutMs + 1_000) {
    const now = performance.now()
    const result = await page.evaluate((id) => {
      const target = window as TerminalMarkerWatchWindow
      const watch = target.__terminalMarkerWatches?.[id]
      const cleanup = (current: TerminalMarkerWatch): void => {
        current.observer?.disconnect()
        current.restoreWrite?.()
        if (current.timer !== undefined) {
          window.clearTimeout(current.timer)
        }
        delete current.restoreWrite
        if (target.__terminalMarkerWatches) {
          delete target.__terminalMarkerWatches[id]
        }
      }
      if (!watch) {
        return null
      }
      if (watch.detectedAt !== null) {
        cleanup(watch)
        return watch.detectedAt - watch.startAt
      }
      if (performance.now() <= watch.deadlineAt + 1_000) {
        return null
      }
      cleanup(watch)
      return Number.NaN
    }, watchId)
    if (result !== null) {
      if (Number.isFinite(result)) {
        return result
      }
      break
    }
    if (now >= nextSerializedFallbackAt) {
      if (await terminalOutputIncludesMarker(page, ptyId, marker, true)) {
        await page.evaluate((id) => {
          const target = window as TerminalMarkerWatchWindow
          const watch = target.__terminalMarkerWatches?.[id]
          watch?.observer?.disconnect()
          watch?.restoreWrite?.()
          if (watch?.timer !== undefined) {
            window.clearTimeout(watch.timer)
          }
          if (target.__terminalMarkerWatches) {
            delete target.__terminalMarkerWatches[id]
          }
        }, watchId)
        return performance.now() - start
      }
      nextSerializedFallbackAt = now + MARKER_SERIALIZE_FALLBACK_INTERVAL_MS
    }
    await page.waitForTimeout(5)
  }
  const [targetTail, focusDebug, pressure] = await Promise.all([
    getTerminalContentForPtyId(page, ptyId, 1_000),
    readFocusedTerminalDebug(page),
    readMainPtyPressureDebug(page)
  ])
  throw new Error(
    `Timed out waiting for terminal marker ${marker}\n${JSON.stringify(
      {
        ptyId,
        focusDebug,
        pressure,
        targetTail
      },
      null,
      2
    )}`
  )
}
