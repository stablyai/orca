import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export async function callColdActivationRuntime<TResult>(
  page: Page,
  method: string,
  params: unknown
): Promise<TResult> {
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

export async function readColdActivationMountState(
  page: Page,
  tabIds: string[]
): Promise<{ mounted: number; parked: number }> {
  return page.evaluate((targets) => {
    const parked = new Set(window.__terminalParkingDebug?.parkedTabIds() ?? [])
    return {
      mounted: targets.filter((id) => window.__paneManagers?.has(id)).length,
      parked: targets.filter((id) => parked.has(id)).length
    }
  }, tabIds)
}

export async function expectStableColdActivationMountState(
  page: Page,
  tabIds: string[],
  expected: { mounted: number; parked: number }
): Promise<void> {
  await expect
    .poll(() => readColdActivationMountState(page, tabIds), { timeout: 30_000 })
    .toEqual(expected)
  const samples = await page.evaluate(async (targets) => {
    const result: { mounted: number; parked: number }[] = []
    for (let index = 0; index < 8; index += 1) {
      const parked = new Set(window.__terminalParkingDebug?.parkedTabIds() ?? [])
      result.push({
        mounted: targets.filter((id) => window.__paneManagers?.has(id)).length,
        parked: targets.filter((id) => parked.has(id)).length
      })
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    return result
  }, tabIds)
  expect(samples).toEqual(Array.from({ length: 8 }, () => expected))
}
