import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const DONE_TEXT = 'Finished — come look!'
const PANE_LEAF_ID = '00000000-0000-4000-8000-000000000001'

test('pet speaks custom text when an agent finishes', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const pane = await orcaPage.evaluate(
    async ({ doneText, leafId, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      await store.getState().updateSettingsOrThrow({
        experimentalPet: true,
        petSpeechDoneText: doneText,
        tabAutoGenerateTitle: false
      })
      const state = store.getState()
      const tab =
        state.tabsByWorktree[worktreeId]?.[0] ??
        state.createTab(worktreeId, undefined, undefined, { activate: false, id: 'pet-speech-tab' })
      const paneKey = `${tab.id}:${leafId}`
      const terminalHandle = 'pet-speech-terminal'
      store
        .getState()
        .setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'Pet speech task', agentType: 'codex' },
          'Codex',
          undefined,
          { tabId: tab.id, terminalHandle, worktreeId }
        )
      return { paneKey, tabId: tab.id, terminalHandle, worktreeId }
    },
    { doneText: DONE_TEXT, leafId: PANE_LEAF_ID, worktreeId }
  )

  const bubble = orcaPage.getByRole('status').filter({ hasText: DONE_TEXT })
  await expect(bubble).toHaveCount(0)

  // Why: the pet mounts lazily; a finish before it mounts is its baseline, not news.
  await orcaPage.locator('[data-pet-overlay]').waitFor({ state: 'attached' })
  await electronApp.evaluate(({ BrowserWindow }, pane) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
    if (!window) {
      throw new Error('Orca BrowserWindow is unavailable')
    }
    const receivedAt = Date.now()
    window.webContents.send('agentStatus:set', {
      ...pane,
      state: 'done',
      prompt: 'Pet speech task',
      agentType: 'codex',
      receivedAt,
      stateStartedAt: receivedAt
    })
  }, pane)

  await expect(bubble).toBeVisible({ timeout: 10_000 })
  const screenshotPath = testInfo.outputPath('pet-speech-bubble.png')
  await orcaPage.screenshot({ path: screenshotPath })
  await testInfo.attach('pet-speech-bubble', { path: screenshotPath, contentType: 'image/png' })

  await bubble.click()
  await expect(bubble).toHaveCount(0)
})
