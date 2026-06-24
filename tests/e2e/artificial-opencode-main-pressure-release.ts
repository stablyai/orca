import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

type SourcePauseSnapshot = {
  sourcePausedPtyCount?: number
}

export async function waitForMainPressureSourcePauseRelease<
  TMainPressure extends SourcePauseSnapshot
>(
  orcaPage: Page,
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
): Promise<void> {
  await expect
    .poll(async () => (await readMainPtyPressureDebug(orcaPage))?.sourcePausedPtyCount ?? null, {
      timeout: 15_000,
      message: 'Main PTY source pause did not release after ACK gate release'
    })
    .toBe(0)
}
