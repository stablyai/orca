import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

async function captureProof(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
    return
  }
  const screenshotPath = testInfo.outputPath(name)
  await page.screenshot({ path: screenshotPath })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('Workspace emoji picker', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.waitForTimeout(750)
  })

  test('inserts emoji in sidebar rename, worktree details, and Cmd+J', async ({
    orcaPage
  }, testInfo) => {
    const title = orcaPage.locator('[data-worktree-title-inline-rename=""]').first()
    await expect(title).toBeVisible()
    await title.dblclick()

    const inlineInput = orcaPage.locator('[data-worktree-title-rename-input="true"]')
    await expect(inlineInput).toBeVisible()
    await inlineInput.fill('Sidebar proof')
    await captureProof(orcaPage, testInfo, 'sidebar-rename-before.png')
    await inlineInput.pressSequentially(' :wink', { delay: 60 })
    const inlineSuggestions = orcaPage.locator('[data-workspace-emoji-suggestions="true"]')
    await expect(inlineSuggestions.getByRole('option', { name: ':wink:' })).toBeVisible()
    await captureProof(orcaPage, testInfo, 'sidebar-rename-picker.png')
    await inlineInput.press('Enter')
    await expect(inlineInput).toHaveValue('Sidebar proof 😉 ')
    await inlineInput.press('Enter')
    await expect(orcaPage.getByText('Sidebar proof 😉', { exact: true }).first()).toBeVisible()

    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id === state.activeWorktreeId)
      if (!worktree) {
        throw new Error('Active worktree not found')
      }
      state.openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        currentDisplayName: worktree.displayName,
        currentComment: worktree.comment,
        focus: 'displayName'
      })
    })

    const detailsDialog = orcaPage.getByRole('dialog', { name: 'Edit Worktree Details' })
    const displayNameInput = detailsDialog.getByPlaceholder('Custom display name...')
    await expect(displayNameInput).toBeFocused()
    await displayNameInput.fill('Details proof')
    await captureProof(orcaPage, testInfo, 'worktree-details-before.png')
    await displayNameInput.pressSequentially(' :wink', { delay: 60 })
    const detailsSuggestions = detailsDialog.locator('[data-workspace-emoji-suggestions="true"]')
    await expect(detailsSuggestions.getByRole('option', { name: ':wink:' })).toBeVisible()
    await captureProof(orcaPage, testInfo, 'worktree-details-picker.png')
    await displayNameInput.press('Enter')
    await expect(displayNameInput).toHaveValue('Details proof 😉 ')
    await detailsDialog.getByRole('button', { name: 'Cancel' }).click()

    await orcaPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    const paletteInput = palette.getByPlaceholder(
      'Search chats, terminals, worktrees, settings, and actions...'
    )
    await expect(paletteInput).toBeFocused()
    await captureProof(orcaPage, testInfo, 'cmd-j-before.png')
    await paletteInput.pressSequentially(':wink', { delay: 60 })
    const paletteSuggestions = palette.locator('[data-workspace-emoji-suggestions="true"]')
    await expect(paletteSuggestions.getByRole('option', { name: ':wink:' })).toBeVisible()
    await captureProof(orcaPage, testInfo, 'cmd-j-picker.png')
    await paletteInput.press('Enter')
    await expect(paletteInput).toHaveValue('😉 ')
    await expect(palette.getByText('Sidebar proof 😉', { exact: true }).first()).toBeVisible()
    await orcaPage.waitForTimeout(750)
  })
})
