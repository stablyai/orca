import { randomUUID } from 'node:crypto'
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { sendToTerminal } from './helpers/terminal'

type TerminalPtyReadinessWindow = Window & {
  __paneManagers?: Map<
    string,
    {
      getPanes?: () => {
        container?: HTMLElement
        serializeAddon?: { serialize?: () => string }
      }[]
    }
  >
}

export async function getTerminalContentForPtyId(
  page: Page,
  ptyId: string,
  charLimit: number
): Promise<string> {
  return page.evaluate(
    ({ ptyId, charLimit }) => {
      const paneManagers = (window as TerminalPtyReadinessWindow).__paneManagers
      for (const manager of paneManagers?.values() ?? []) {
        for (const pane of manager.getPanes?.() ?? []) {
          if (pane.container?.dataset?.ptyId === ptyId) {
            return (pane.serializeAddon?.serialize?.() ?? '').slice(-charLimit)
          }
        }
      }
      return ''
    },
    { ptyId, charLimit }
  )
}

export async function waitForPtyPaneMounted(
  page: Page,
  ptyId: string,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((ptyId) => {
          const paneManagers = (window as TerminalPtyReadinessWindow).__paneManagers
          for (const manager of paneManagers?.values() ?? []) {
            if (
              manager
                .getPanes?.()
                .some((pane) => pane.container?.dataset?.ptyId === ptyId && pane.serializeAddon)
            ) {
              return true
            }
          }
          return false
        }, ptyId),
      {
        timeout: timeoutMs,
        message: `terminal pane for PTY ${ptyId} was not mounted before shell probing`
      }
    )
    .toBe(true)
}

function encodedMarkerCommand(marker: string): string {
  const encoded = Buffer.from(marker, 'utf8').toString('base64')
  return `node -e ${JSON.stringify(
    `console.log(Buffer.from('${encoded}', 'base64').toString('utf8'))`
  )}\r`
}

export async function waitForPtyShellEcho(
  page: Page,
  ptyId: string,
  timeoutMs: number
): Promise<void> {
  const marker = `ORCA_PTY_READY_${randomUUID()}`
  const deadline = Date.now() + timeoutMs
  await waitForPtyPaneMounted(page, ptyId, Math.min(10_000, timeoutMs))
  while (Date.now() < deadline) {
    await sendToTerminal(page, ptyId, '\x03')
    await page.waitForTimeout(50)
    await sendToTerminal(page, ptyId, '\x15')
    await page.waitForTimeout(50)

    // Why: terminal scrollback includes command echo. Encode the marker inside
    // the node snippet so seeing the plain marker proves the shell executed it.
    await sendToTerminal(page, ptyId, encodedMarkerCommand(marker))

    const probeDeadline = Date.now() + Math.min(3_000, Math.max(0, deadline - Date.now()))
    while (Date.now() < probeDeadline) {
      if ((await getTerminalContentForPtyId(page, ptyId, 30_000)).includes(marker)) {
        return
      }
      await page.waitForTimeout(100)
    }
  }
  throw new Error(`PTY shell for ${ptyId} never echoed readiness marker within ${timeoutMs}ms`)
}
