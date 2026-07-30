import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export async function waitForHiddenPressureCompletion(
  orcaPage: Page,
  hiddenPanes: { ptyId: string }[],
  runId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          async ({ panes, markerPrefix }) => {
            const snapshots = await Promise.all(
              panes.map((pane) =>
                window.api.pty.getMainBufferSnapshot(pane.ptyId, { scrollbackRows: 50 })
              )
            )
            return snapshots.filter((snapshot, index) =>
              snapshot?.data.includes(`${markerPrefix}${index}`)
            ).length
          },
          { panes: hiddenPanes, markerPrefix: `OPENCODE_PRESSURE_DONE_${runId}_` }
        ),
      { timeout: 60_000, message: 'Hidden PTY pressure generators did not finish' }
    )
    .toBe(hiddenPanes.length)
}
