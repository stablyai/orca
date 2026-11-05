import type { Page } from '@stablyai/playwright-test'

export type TerminalMultiplexLifecycleSnapshot = {
  activeStreams: { environmentId: string; streamId: number; terminal: string }[]
  streamSubscribeCount: number
  streamUnsubscribeCount: number
  transportSubscribeCount: number
  transportUnsubscribeCount: number
}

export async function readTerminalMultiplexLifecycle(
  page: Page
): Promise<TerminalMultiplexLifecycleSnapshot> {
  return page.evaluate(() => {
    const gate = (
      window as typeof window & {
        __remoteTerminalMultiplexAckGate?: {
          snapshot: () => TerminalMultiplexLifecycleSnapshot
        }
      }
    ).__remoteTerminalMultiplexAckGate
    if (!gate) {
      throw new Error('remote terminal multiplex lifecycle observer unavailable')
    }
    const snapshot = gate.snapshot()
    return {
      activeStreams: snapshot.activeStreams,
      streamSubscribeCount: snapshot.streamSubscribeCount,
      streamUnsubscribeCount: snapshot.streamUnsubscribeCount,
      transportSubscribeCount: snapshot.transportSubscribeCount,
      transportUnsubscribeCount: snapshot.transportUnsubscribeCount
    }
  })
}

export async function startTerminalReconnectUiObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as typeof window & {
      __sta4150ReconnectUiObserver?: { disconnect: () => void; events: string[] }
    }
    target.__sta4150ReconnectUiObserver?.disconnect()
    const events: string[] = []
    const scan = (): void => {
      for (const selector of [
        '[data-terminal-remote-runtime-reconnect-banner]',
        '[data-terminal-error-toast]'
      ]) {
        if (document.querySelector(selector) && !events.includes(selector)) {
          events.push(selector)
        }
      }
    }
    const observer = new MutationObserver(scan)
    observer.observe(document.body, { childList: true, subtree: true })
    scan()
    target.__sta4150ReconnectUiObserver = {
      disconnect: () => observer.disconnect(),
      events
    }
  })
}

export async function readTerminalReconnectUiEvents(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __sta4150ReconnectUiObserver?: { events: string[] }
        }
      ).__sta4150ReconnectUiObserver?.events ?? []
  )
}
