import { expect, type CDPSession, type Page, type TestInfo } from '@stablyai/playwright-test'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
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
  // Wait for the prompt after PTY binding so initial snapshot replay cannot overwrite the test row during composition.
  await expect
    .poll(() => getTerminalContent(page), {
      // Match the manager wait above so loaded default-worker runs do not time out first on setup.
      timeout: 30_000,
      message: 'Active terminal did not render its initial PTY frame'
    })
    .not.toBe('')
  const session = await page.context().newCDPSession(page)
  await focusActiveTerminalInput(page)
  await installTerminalImeBoundaryProbe(page)
  return { page, session, ptyId }
}

// On failure, interrupt a mid-composition byte reader so the next shared-worker test gets the pane back.
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
