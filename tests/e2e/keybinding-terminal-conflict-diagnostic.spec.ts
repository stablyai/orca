import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const CONFLICTING_FILE = `${JSON.stringify(
  { version: 1, keybindings: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] } },
  null,
  2
)}\n`

test.describe('Terminal shortcut conflicting with a chord main intercepts', () => {
  test('keeps the saved override and reports the conflict in Settings', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)

    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    mkdirSync(path.join(isolatedHome, '.orca'), { recursive: true })
    writeFileSync(path.join(isolatedHome, '.orca', 'keybindings.json'), CONFLICTING_FILE)

    const savedOverride = await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      await store.getState().updateSettings({ uiLanguage: 'en' })
      await store.getState().reloadKeybindings()
      store.getState().openSettingsPage()
      return store.getState().keybindings['terminal.splitRight']
    })
    expect(savedOverride).toEqual(['Mod+Alt+ArrowRight'])

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('shortcuts')
    await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()

    await orcaPage.getByRole('button', { name: /Conflicts/ }).click()
    await expect(orcaPage.getByText('Split terminal right', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Worktree History Forward', { exact: true })).toBeVisible()
    await expect(
      orcaPage.getByText(/conflicts with .*Worktree History Forward/).first()
    ).toBeVisible()
  })
})
