import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Mod+Alt+ArrowRight is worktree.history.forward's default on every platform,
// and that action is allowInTerminal, so it consumes the chord while a terminal
// is focused. A terminal binding on the same chord can never fire.
const CONFLICTING_FILE = `${JSON.stringify(
  { version: 1, keybindings: { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] } },
  null,
  2
)}\n`

const shotDir = process.env.ORCA_SHOT_DIR
const shotLabel = process.env.ORCA_SHOT_LABEL ?? 'after'

test.describe('Terminal shortcut conflicting with a chord that fires in terminals', () => {
  test('surfaces the binding as ignored instead of dropping it silently', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)

    // Why: seed inside the E2E isolated HOME so the spec never reads or writes
    // the developer's real ~/.orca/keybindings.json.
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    mkdirSync(path.join(isolatedHome, '.orca'), { recursive: true })
    writeFileSync(path.join(isolatedHome, '.orca', 'keybindings.json'), CONFLICTING_FILE)

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: the spec asserts on English strings; the host may run another locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      await store.getState().reloadKeybindings()
      store.getState().openSettingsPage()
    })

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('shortcuts')
    await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()

    if (shotDir) {
      await orcaPage.screenshot({ path: path.join(shotDir, `${shotLabel}-1-shortcuts-pane.png`) })
    }

    await orcaPage.getByPlaceholder('Search command or keys').fill('split terminal')
    await expect(orcaPage.getByText('Split terminal right', { exact: true })).toBeVisible()

    if (shotDir) {
      await orcaPage.screenshot({ path: path.join(shotDir, `${shotLabel}-2-split-terminal.png`) })
    }

    // Before the fix the pane reported no conflict at all: the chord was lost to
    // worktree history, the override was dropped, and nothing said why.
    await expect(
      orcaPage.getByText('was ignored — it conflicts with Worktree History Forward', {
        exact: false
      })
    ).toBeVisible()
    await expect(
      orcaPage.getByText('Conflicting custom shortcuts were ignored', { exact: false })
    ).toBeVisible()
  })
})
