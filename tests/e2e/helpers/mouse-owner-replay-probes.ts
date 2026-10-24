import type { Page } from '@stablyai/playwright-test'

type MouseReplayWrite = { data: string | Uint8Array; stack: string | undefined; time: number }

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    __mouseProofWrites?: MouseReplayWrite[]
  }
}

export async function installWriteProbe(page: Page, tabId: string) {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      throw new Error('No terminal to instrument')
    }
    const writes: MouseReplayWrite[] = []
    window.__mouseProofWrites = writes
    const original = pane.terminal.write.bind(pane.terminal)
    pane.terminal.write = (data, callback) => {
      writes.push({ data, stack: new Error('Mouse replay write probe').stack, time: Date.now() })
      return original(data, callback)
    }
  }, tabId)
}

export async function readWriteProbe(page: Page, drain = false) {
  return page.evaluate((drain) => {
    const writes = window.__mouseProofWrites
    if (!writes) {
      throw new Error('Mouse replay write probe is not installed')
    }
    return drain ? writes.splice(0) : writes.slice()
  }, drain)
}

export async function hostSnapshot(page: Page, environmentId: string, handle: string) {
  return page.evaluate(
    async ({ environmentId, handle }) => {
      let settle: (value: unknown) => void = () => {}
      const received = new Promise<unknown>((resolve) => {
        settle = resolve
      })
      const subscription = await window.api.runtimeEnvironments.subscribe(
        {
          selector: environmentId,
          method: 'terminal.subscribe',
          params: { terminal: handle },
          timeoutMs: 10_000
        },
        {
          onResponse: (response) => {
            if (
              response.ok &&
              typeof response.result === 'object' &&
              response.result &&
              'type' in response.result &&
              response.result.type === 'scrollback'
            ) {
              settle(response.result)
            }
          },
          onError: (error) => settle({ error })
        }
      )
      const timer = setTimeout(() => settle({ error: 'snapshot timeout' }), 10_000)
      try {
        return await received
      } finally {
        clearTimeout(timer)
        subscription.unsubscribe()
      }
    },
    { environmentId, handle }
  )
}

export async function probeMotion(page: Page, tabId: string) {
  return page.evaluate(async (tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane?.terminal.element) {
      throw new Error('No terminal surface')
    }
    const terminal = pane.terminal
    await new Promise<void>((resolve) => terminal.write('', resolve))
    const screen = terminal.element?.querySelector('.xterm-screen')
    if (!screen) {
      throw new Error('No terminal screen')
    }
    const reports: string[] = []
    const subscription = terminal.onData((data) => {
      if (data.includes('\x1b[<')) {
        reports.push(data)
      }
    })
    const rect = screen.getBoundingClientRect()
    try {
      for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        screen.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            clientX: rect.left + rect.width * fraction,
            clientY: rect.top + rect.height * 0.5
          })
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      const buffer = terminal.buffer.active
      const lines = Array.from(
        { length: terminal.rows },
        (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
      )
      return {
        mode: terminal.modes.mouseTrackingMode,
        focusReporting: terminal.modes.sendFocusMode,
        reports,
        text: lines.join('\n')
      }
    } finally {
      subscription.dispose()
    }
  }, tabId)
}
