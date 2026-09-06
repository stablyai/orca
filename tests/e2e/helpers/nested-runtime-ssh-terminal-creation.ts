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
  await client.page.getByRole('button', { name: 'New tab' }).click({ force: true })
  await client.page
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
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
  const ptyId = await waitForActivePanePtyId(client.page, 30_000)
  await focusActiveTerminalInput(client.page)
  const trace = await client.page.evaluateHandle(() => {
    const state = window.__store!.getState()
    const manager = window.__paneManagers!.get(state.activeTabId!)!
    const active = () => ({tag:document.activeElement?.tagName, className:document.activeElement?.className})
    const entries = manager.getPanes().map((pane) => ({ptyId:pane.container.dataset.ptyId, data:'', focused:pane.container.contains(document.activeElement)}))
    const subscriptions = manager.getPanes().map((pane,index) => pane.terminal.onData((data) => {entries[index].data=(entries[index].data+data).slice(-2048)}))
    return {entries, before:active(), active, dispose:() => subscriptions.forEach((s) => s.dispose())}
  })
  try {
    await client.page.keyboard.insertText(terminalMarkerCommand(marker))
    await client.page.keyboard.press('Enter')
    await expect.poll(() => getTerminalContent(client.page), { timeout: 30_000 }).toContain(marker)
  } finally {
    console.log('[nested-created-input]', marker, JSON.stringify(await trace.evaluate((t) => ({entries:t.entries,before:t.before,after:t.active()}))))
    await trace.evaluate((t) => t.dispose())
    await trace.dispose()
  }
  return { ptyId, tabId }
}
