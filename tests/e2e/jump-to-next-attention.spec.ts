import { writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const WAITING_LEAF_ID = '00000000-0000-4000-8000-000000012577'

test('Mod+Shift+K jumps to the worktree whose agent needs input', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const startWorktreeId = await waitForActiveWorktree(orcaPage)
  const waitingWorktreeId = (await getAllWorktreeIds(orcaPage)).find(
    (worktreeId) => worktreeId !== startWorktreeId
  )
  if (!waitingWorktreeId) {
    throw new Error('the e2e fixture must seed at least two worktrees')
  }

  await orcaPage.evaluate(
    ({ worktreeId, leafId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const tab = store.getState().createTab(worktreeId, undefined, undefined, {
        activate: false,
        id: 'jump-to-next-attention-tab'
      })
      const now = Date.now()
      store
        .getState()
        .setAgentStatus(
          `${tab.id}:${leafId}`,
          { state: 'waiting', prompt: 'Approve the migration plan?', agentType: 'claude' },
          'Claude Code',
          { updatedAt: now, stateStartedAt: now },
          { tabId: tab.id, terminalHandle: 'jump-to-next-attention', worktreeId }
        )
    },
    { worktreeId: waitingWorktreeId, leafId: WAITING_LEAF_ID }
  )

  const worktreeRow = (worktreeId: string) =>
    orcaPage.locator(`[role="option"][data-worktree-id="${worktreeId}"]`)
  await expect(worktreeRow(startWorktreeId)).toHaveAttribute('aria-current', 'page')

  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  async function screenshot(name: string): Promise<void> {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = testInfo.outputPath(name)
    writeFileSync(screenshotPath, Buffer.from(data, 'base64'))
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
  }
  await screenshot('before.png')

  await orcaPage.keyboard.press(`${modifier}+Shift+K`)

  await expect(worktreeRow(waitingWorktreeId)).toHaveAttribute('aria-current', 'page')
  await expect(worktreeRow(startWorktreeId)).not.toHaveAttribute('aria-current', 'page')
  await screenshot('after.png')
})
