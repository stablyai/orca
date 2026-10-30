import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalRead } from '../../../src/shared/runtime-types'
import { startRendererLagProbe } from '../paired-runtime-retention-metrics'
import { expect } from './orca-app'

const MAX_HIDDEN_FLOOD_LAG_MS = 500

type HiddenPairedTerminal = {
  tabId: string
  terminal: string
}

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

export async function verifyHiddenPairedTerminalOutputSuppression(
  page: Page,
  terminals: HiddenPairedTerminal[]
): Promise<string[]> {
  await page.evaluate(() => window.__store?.getState().setActiveView('tasks'))
  await expect
    .poll(
      () =>
        page.evaluate(
          (ids) => ids.filter((id) => window.__paneManagers?.has(id)).length,
          terminals.map((terminal) => terminal.tabId)
        ),
      { timeout: 10_000 }
    )
    .toBe(terminals.length)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
  await page.evaluate(() => {
    const debug = (
      window as typeof window & {
        __terminalOutputSchedulerDebug?: { reset: () => void }
      }
    ).__terminalOutputSchedulerDebug
    if (!debug) {
      throw new Error('Terminal output scheduler debug API is unavailable')
    }
    debug.reset()
  })

  const lagProbe = await startRendererLagProbe(page)
  const tokens = terminals.map((_, index) => `HIDDEN_FLOOD_${index}_${Date.now()}`)
  try {
    await Promise.all(
      terminals.map((terminal, index) =>
        callRuntime(page, 'terminal.send', {
          terminal: terminal.terminal,
          text: `FLOOD:${tokens[index]}`,
          enter: true,
          client: { id: 'paired-hidden-flood-e2e', type: 'desktop' }
        })
      )
    )
    await expect
      .poll(
        async () =>
          Promise.all(
            terminals.map(async (terminal, index) => {
              const result = await callRuntime<{ terminal: RuntimeTerminalRead }>(
                page,
                'terminal.read',
                { terminal: terminal.terminal, limit: 1_000 }
              )
              return result.terminal.tail.join('\n').includes(`FLOODED:${tokens[index]}`)
            })
          ),
        { timeout: 30_000 }
      )
      .toEqual(Array(terminals.length).fill(true))
    const hiddenFloodLagMs = await lagProbe.evaluate((probe) => probe.stop())
    const scheduler = await page.evaluate(
      () =>
        (
          window as typeof window & {
            __terminalOutputSchedulerDebug?: {
              snapshot: () => {
                backgroundEnqueueCount: number
                queuedChars: number
                scheduledDrainCount: number
              }
            }
          }
        ).__terminalOutputSchedulerDebug?.snapshot() ?? null
    )
    expect(scheduler).not.toBeNull()
    expect(scheduler?.backgroundEnqueueCount).toBe(0)
    expect(scheduler?.scheduledDrainCount).toBe(0)
    expect(scheduler?.queuedChars).toBe(0)
    expect(hiddenFloodLagMs).toBeLessThan(MAX_HIDDEN_FLOOD_LAG_MS)
  } finally {
    await lagProbe.evaluate((probe) => probe.stop()).catch(() => undefined)
    await lagProbe.dispose()
  }
  return tokens
}
