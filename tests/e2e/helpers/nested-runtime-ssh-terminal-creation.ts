import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'
import { focusActiveTerminalInput, getTerminalContent, waitForActivePanePtyId } from './terminal'
import { terminalMarkerCommand } from './terminal-output-marker'

export async function assertPairedTerminalCreation(
  client: PairedElectronClient,
  marker: string
): Promise<{ ptyId: string; tabId: string }> {
  const before = await client.page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId ? (state?.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id) : []
  })
  await client.page.getByRole('button', { name: 'New tab' }).click()
  await client.page
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click()
  let tabId = ''
  await expect
    .poll(
      async () => {
        tabId = await client.page.evaluate((oldIds) => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          return (
            (worktreeId ? state?.tabsByWorktree[worktreeId] : [])?.find(
              (tab) => !oldIds.includes(tab.id)
            )?.id ?? ''
          )
        }, before)
        return tabId
      },
      { timeout: 30_000, message: 'Paired New Terminal did not create a HUB-owned tab' }
    )
    .not.toBe('')
  await expect
    .poll(
      () =>
        client.page.evaluate(() => {
          const state = window.__store?.getState()
          return state?.activeTabType === 'terminal' ? state.activeTabId : null
        }),
      { timeout: 30_000, message: 'Paired New Terminal did not activate the newly created tab' }
    )
    .toBe(tabId)
  const ptyId = await waitForActivePanePtyId(client.page, 30_000)
  await focusActiveTerminalInput(client.page)
  await client.page.keyboard.insertText(terminalMarkerCommand(marker))
  await client.page.keyboard.press('Enter')
  await expect.poll(() => getTerminalContent(client.page), { timeout: 30_000 }).toContain(marker)
  return { ptyId, tabId }
}
