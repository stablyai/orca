import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

// Why: an unpublished, obviously-fixture name — the setting is disabled
// before the hover fires, so the pipeline must never reach the registry.
const DEPENDENCY_NAME = 'orca-e2e-hover-fixture'
const INSTALLED_VERSION = '2.4.6'

test('@golden shows the disabled-lookup message and installed version when hovering a package.json dependency', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'npm-hover')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))

  writeFileSync(
    path.join(fixture.worktreePath, 'package.json'),
    `${JSON.stringify(
      {
        name: 'orca-e2e-test',
        version: '0.0.0',
        private: true,
        dependencies: { [DEPENDENCY_NAME]: '^2.0.0' }
      },
      null,
      2
    )}\n`
  )
  // Why: the hoist walk reads node_modules/<pkg>/package.json from the
  // worktree root — real fs, no npm install needed, keeps the spec hermetic.
  const installedPackageDir = path.join(fixture.worktreePath, 'node_modules', DEPENDENCY_NAME)
  mkdirSync(installedPackageDir, { recursive: true })
  writeFileSync(
    path.join(installedPackageDir, 'package.json'),
    `${JSON.stringify({ name: DEPENDENCY_NAME, version: INSTALLED_VERSION }, null, 2)}\n`
  )

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)

  // Setup only: flips the same privacy switch the Settings UI drives, through
  // the real renderer->main IPC round trip. The assertion below never reads
  // the store back — it reads the rendered hover tooltip. uiLanguage is
  // pinned to English because the spec asserts on English strings and the
  // host machine may run a non-English system locale.
  await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettingsOrThrow({
      npmPackageInfoOnlineLookupsEnabled: false,
      uiLanguage: 'en'
    })
  })
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarTab('explorer')
    state?.setRightSidebarOpen(true)
  })

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  const packageJsonRow = explorer.locator('[data-file-explorer-row]').filter({
    has: orcaPage
      .locator('[data-file-explorer-row-name]')
      .getByText('package.json', { exact: true })
  })
  await expect(packageJsonRow).toBeVisible({ timeout: 10_000 })
  await packageJsonRow.dblclick()

  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('package.json', {
    timeout: 20_000
  })
  const monacoEditor = orcaPage.locator('.monaco-editor').first()
  await expect(monacoEditor).toBeVisible({ timeout: 25_000 })

  // Why: Monaco's JSON tokenizer scans a whole quoted string as one token, so
  // the rendered dependency key is exactly one span with its quotes intact.
  const dependencyToken = monacoEditor.getByText(`"${DEPENDENCY_NAME}"`, { exact: true })
  await expect(dependencyToken).toBeVisible({ timeout: 10_000 })
  // Real pointer move — Monaco's hover controller only listens to genuine
  // mousemove events, and the hover widget has its own render delay.
  await dependencyToken.hover()

  // Why: Monaco's hover widget exposes an accessible `tooltip` role, which
  // sidesteps the internal overlay-container class structure entirely. Named
  // to disambiguate from unrelated app toast tooltips sharing the role.
  const hoverWidget = orcaPage.getByRole('tooltip', { name: DEPENDENCY_NAME })
  await expect(hoverWidget).toBeVisible({ timeout: 10_000 })
  // Why the installed version is the assertion: with lookups off the tooltip
  // carries no registry content and never explains its own limits, so the
  // locally-read version is the only thing left — and it can only reach the
  // DOM if detection, the IPC round trip, the markdown build and the Monaco
  // render all completed.
  await expect(hoverWidget).toContainText(INSTALLED_VERSION)
  await expect(hoverWidget).not.toContainText(/not found|disabled|Could not complete/i)
})
