import type { CDPSession, Page, TestInfo } from '@stablyai/playwright-test'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe
} from './terminal-ime-boundary-probe'

/** A focused terminal pane with a CDP session and the boundary probe already attached. */
export type TerminalImePaneArena = {
  page: Page
  session: CDPSession
  ptyId: string
}

export async function openTerminalImePaneArena(page: Page): Promise<TerminalImePaneArena> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  const session = await page.context().newCDPSession(page)
  await focusActiveTerminalInput(page)
  await installTerminalImeBoundaryProbe(page)
  return { page, session, ptyId }
}

/**
 * `interrupt` sends Ctrl+C only when the test did not reach its end, so a spec that failed
 * mid-composition cannot leave a byte reader holding the pane for the next test in the worker.
 */
export async function closeTerminalImePaneArena(
  arena: TerminalImePaneArena,
  testInfo: TestInfo,
  evidenceName: string,
  interrupt: boolean
): Promise<void> {
  await attachTerminalImeBoundaryEvidence(arena.page, testInfo, evidenceName).catch(() => undefined)
  await disposeTerminalImeBoundaryProbe(arena.page).catch(() => undefined)
  await arena.session.detach().catch(() => undefined)
  if (interrupt) {
    await sendToTerminal(arena.page, arena.ptyId, '\x03').catch(() => undefined)
  }
}
