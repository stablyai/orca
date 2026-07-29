import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { buildFreshShellProbeInputSequence } from '../terminal-probe-input-sequence'

type ReadinessAttempt = {
  marker: string
  paneInstanceId: string
}

export async function waitForRestoredTerminalInputReady(
  page: Page,
  expectedPtyId: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // Why: ConPTY echo can lag behind the poll interval, so retain every marker
  // sent to the current concrete pane instead of chasing only the newest one.
  let pendingAttempts: readonly ReadinessAttempt[] = []

  while (Date.now() < deadline) {
    const marker = `ORCA_RESTORED_INPUT_READY_${randomUUID().replaceAll('-', '')}`
    const [input] = buildFreshShellProbeInputSequence(`echo ${marker}\r`)
    if (!input) {
      return false
    }
    try {
      const result = await page.evaluate(
        ({ expectedPtyId, input, pendingAttempts }) => {
          for (const manager of window.__paneManagers?.values() ?? []) {
            const pane = manager.getActivePane?.() ?? manager.getPanes?.()[0]
            if (pane?.container?.dataset?.ptyId !== expectedPtyId) {
              continue
            }
            const container = pane.container as HTMLElement & {
              __orcaE2eTerminalInputReadinessInstanceId?: string
            }
            container.__orcaE2eTerminalInputReadinessInstanceId ??= crypto.randomUUID()
            const paneInstanceId = container.__orcaE2eTerminalInputReadinessInstanceId
            const output = pane.serializeAddon?.serialize?.() ?? ''
            if (
              pendingAttempts.some(
                (attempt) =>
                  attempt.paneInstanceId === paneInstanceId && output.includes(attempt.marker)
              )
            ) {
              return { ready: true, paneInstanceId }
            }
            // Why: one input() payload is either wholly replay-suppressed or
            // wholly forwarded, unlike character-by-character keyboard typing.
            pane.terminal.input(input, true)
            return { ready: false, paneInstanceId }
          }
          return null
        },
        { expectedPtyId, input, pendingAttempts }
      )
      if (result?.ready) {
        return true
      }
      pendingAttempts = result
        ? [
            ...pendingAttempts.filter(
              (attempt) => attempt.paneInstanceId === result.paneInstanceId
            ),
            { marker, paneInstanceId: result.paneInstanceId }
          ]
        : []
    } catch {
      // Relaunch can replace the document between polls; the next attempt
      // resolves the current pane and binding instead of retaining stale state.
      pendingAttempts = []
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs > 0) {
      await page.waitForTimeout(Math.min(100, remainingMs))
    }
  }
  return false
}
