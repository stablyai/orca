import { runProcessSync } from '@orca/process-host'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForActivePanePtyId } from '../../terminal/input/terminal'
import { waitForSessionReady } from '../../desktop/renderer-probes/store'

test.use({ seedTestRepo: false })

function git(repo: string, ...args: string[]) {
  const result = runProcessSync({
    program: 'git',
    args: ['-C', repo, '-c', 'commit.gpgsign=false', ...args]
  })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
}
function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-selected-checkout-')))
  const primary = join(root, 'primary')
  const selected = join(root, 'selected')
  const sibling = join(root, 'hidden-sibling')
  mkdirSync(primary)
  git(primary, 'init', '-b', 'main')
  writeFileSync(join(primary, 'README.md'), '# Checkout handoff\n')
  git(primary, 'add', '.')
  git(
    primary,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'Initial'
  )
  return { root, primary, selected, sibling }
}

test('Add Project opens the selected hidden checkout and its subfolder without revealing siblings', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const paths = createFixture()
  registerPostElectronShutdownCleanup(async () =>
    rmSync(paths.root, { recursive: true, force: true })
  )
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  const repoId = await orcaPage.evaluate(async (primary) => {
    const s = window.__store!.getState()
    const repo = await s.addRepoPath(primary, 'git', { runtimeEnvironmentId: null })
    if (!repo) {
      throw new Error('Primary registration failed')
    }
    await s.fetchWorktrees(repo.id, { executionHostId: 'local', requireAuthoritative: true })
    return repo.id
  }, paths.primary)
  // The host has a recent catalog from before these external checkouts existed.
  git(paths.primary, 'worktree', 'add', '-b', 'chosen-topic', paths.selected)
  git(paths.primary, 'worktree', 'add', '-b', 'hidden-topic', paths.sibling)
  mkdirSync(join(paths.selected, 'src'))
  const alias = join(paths.root, 'selected-alias')
  symlinkSync(paths.selected, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await orcaPage.screenshot({ path: testInfo.outputPath('before-add.png') })
  await orcaPage.evaluate(
    (selected) =>
      window.__store!.getState().openModal('add-repo', {
        entryRequest: {
          id: 1,
          kind: 'picked-local-paths',
          hostId: 'local',
          paths: [selected]
        }
      }),
    paths.selected
  )
  const selectedId = `${repoId}::${paths.selected}`
  const row = orcaPage
    .locator('[role="option"][data-worktree-id]')
    .filter({ hasText: 'chosen-topic' })
  await expect(row).toHaveAttribute('aria-current', 'page', { timeout: 30_000 })
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
    .toBe(selectedId)
  const after = await orcaPage.evaluate((id) => {
    const s = window.__store!.getState()
    return {
      paths: s.worktreesByRepo[id].map((row) => row.path),
      imported: s.repos.find((repo) => repo.id === id)?.importedExternalWorktreePaths
    }
  }, repoId)
  expect(after.paths).toEqual([paths.primary, paths.selected])
  expect(after.imported).toEqual([paths.selected])
  await expect(
    orcaPage.locator('[role="option"][data-worktree-id]').filter({ hasText: 'hidden-topic' })
  ).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('after-selected-checkout.png') })
  await orcaPage.evaluate(
    (folderPath) =>
      window.__store!.getState().openModal('confirm-add-project-from-folder', { folderPath }),
    join(alias, 'src')
  )
  const dialog = orcaPage.getByRole('dialog', { name: 'Add Project', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Add Project', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(row).toHaveAttribute('aria-current', 'page')
  await orcaPage.screenshot({ path: testInfo.outputPath('after-subfolder.png') })
})

test('direct folder admission resolves an alias and starts the first terminal in the selected subfolder', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const paths = createFixture()
  registerPostElectronShutdownCleanup(async () =>
    rmSync(paths.root, { recursive: true, force: true })
  )
  git(paths.primary, 'worktree', 'add', '-b', 'selected-subfolder', paths.selected)
  git(paths.primary, 'worktree', 'add', '-b', 'hidden-sibling', paths.sibling)
  mkdirSync(join(paths.selected, 'src'))
  const alias = join(paths.root, 'alias')
  symlinkSync(paths.selected, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await orcaPage.evaluate(async (primary) => {
    await window.__store!.getState().addRepoPath(primary, 'git', { runtimeEnvironmentId: null })
  }, paths.primary)
  await orcaPage.evaluate(
    (folderPath) =>
      window.__store!.getState().openModal('confirm-add-project-from-folder', { folderPath }),
    join(alias, 'src')
  )
  const dialog = orcaPage.getByRole('dialog', { name: 'Add Project', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Add Project', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(
    orcaPage.locator('[role="option"][data-worktree-id]').filter({ hasText: 'selected-subfolder' })
  ).toHaveAttribute('aria-current', 'page')
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await expect
    .poll(() => orcaPage.evaluate((id) => window.api.pty.getCwd(id), ptyId))
    .toBe(join(paths.selected, 'src'))
  await expect(
    orcaPage.locator('[role="option"][data-worktree-id]').filter({ hasText: 'hidden-sibling' })
  ).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('direct-subfolder-cwd.png') })
})

test('runtime reuse and targeted import discard the recent host catalog', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const paths = createFixture()
  registerPostElectronShutdownCleanup(async () =>
    rmSync(paths.root, { recursive: true, force: true })
  )
  await waitForSessionReady(orcaPage)
  const repoId = await orcaPage.evaluate(async (path) => {
    const added = await window.api.runtime.call({ method: 'repo.add', params: { path } })
    if (!added.ok) {
      throw new Error(added.error.message)
    }
    if (!added.result || typeof added.result !== 'object' || !('repo' in added.result)) {
      throw new Error('Missing runtime project')
    }
    const repo = added.result.repo
    if (!repo || typeof repo !== 'object' || !('id' in repo) || typeof repo.id !== 'string') {
      throw new Error('Missing runtime project ID')
    }
    const primed = await window.api.runtime.call({
      method: 'worktree.detectedList',
      params: { repo: repo.id }
    })
    if (!primed.ok) {
      throw new Error(primed.error.message)
    }
    return repo.id
  }, paths.primary)
  git(paths.primary, 'worktree', 'add', '-b', 'runtime-selected', paths.selected)
  git(paths.primary, 'worktree', 'add', '-b', 'runtime-hidden', paths.sibling)
  const result = await orcaPage.evaluate(
    async ({ primary, selected, repoId }) => {
      const started = performance.now()
      const reused = await window.api.runtime.call({
        method: 'repo.add',
        params: { path: primary }
      })
      if (!reused.ok) {
        throw new Error(reused.error.message)
      }
      const reuseMs = performance.now() - started
      const discovered = await window.api.runtime.call({
        method: 'worktree.detectedList',
        params: { repo: repoId }
      })
      if (!discovered.ok) {
        throw new Error(discovered.error.message)
      }
      const beforeImport = performance.now()
      const updated = await window.api.runtime.call({
        method: 'repo.update',
        params: { repo: repoId, updates: { importedExternalWorktreePaths: [selected] } }
      })
      if (!updated.ok) {
        throw new Error(updated.error.message)
      }
      const imported = await window.api.runtime.call({
        method: 'worktree.detectedList',
        params: { repo: repoId }
      })
      if (!imported.ok) {
        throw new Error(imported.error.message)
      }
      return {
        reused: reused.result,
        discovered: discovered.result,
        imported: imported.result,
        reuseMs,
        importAndScanMs: performance.now() - beforeImport
      }
    },
    { ...paths, repoId }
  )
  expect(result.reused).toMatchObject({ repo: { id: repoId }, selectedPath: paths.primary })
  expect(result.discovered).toMatchObject({
    authoritative: true,
    worktrees: expect.arrayContaining([
      expect.objectContaining({ path: paths.selected, visible: false }),
      expect.objectContaining({ path: paths.sibling, visible: false })
    ])
  })
  expect(result.imported).toMatchObject({
    authoritative: true,
    worktrees: expect.arrayContaining([
      expect.objectContaining({ path: paths.selected, visible: true }),
      expect.objectContaining({ path: paths.sibling, visible: false })
    ])
  })
  await testInfo.attach('runtime-add-import-observations', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json'
  })
})

test('failed confirmation keeps the selected import and lets Retry open it', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const paths = createFixture()
  registerPostElectronShutdownCleanup(async () =>
    rmSync(paths.root, { recursive: true, force: true })
  )
  git(paths.primary, 'worktree', 'add', '-b', 'retry-selected', paths.selected)
  git(paths.primary, 'worktree', 'add', '-b', 'retry-hidden', paths.sibling)
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  const repoId = await orcaPage.evaluate(async ({ primary, selected }) => {
    const store = window.__store!
    const repo = await store.getState().addRepoPath(primary, 'git', { runtimeEnvironmentId: null })
    if (!repo) {
      throw new Error('Primary registration failed')
    }
    const original = store.getState().fetchWorktrees
    // Inject one failed local confirmation; the saved import still goes through real persistence.
    Object.assign(store.getState(), {
      fetchWorktrees: async (id: string, options?: { forceFresh?: boolean }) => {
        if (
          options?.forceFresh &&
          store
            .getState()
            .repos.find((row) => row.id === id)
            ?.importedExternalWorktreePaths?.includes(selected)
        ) {
          store.setState({ fetchWorktrees: original })
          return false
        }
        return original(id, options)
      }
    })
    store.getState().openModal('confirm-add-project-from-folder', { folderPath: selected })
    return repo.id
  }, paths)
  const dialog = orcaPage.getByRole('dialog', { name: 'Add Project', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Add Project', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  const retry = orcaPage.getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  expect(
    await orcaPage.evaluate(
      (id) =>
        window.__store!.getState().repos.find((row) => row.id === id)
          ?.importedExternalWorktreePaths,
      repoId
    )
  ).toEqual([paths.selected])
  await orcaPage.screenshot({ path: testInfo.outputPath('failed-confirmation-retry.png') })
  await retry.click()
  await expect(
    orcaPage.locator('[role="option"][data-worktree-id]').filter({ hasText: 'retry-selected' })
  ).toHaveAttribute('aria-current', 'page')
  await expect(
    orcaPage.locator('[role="option"][data-worktree-id]').filter({ hasText: 'retry-hidden' })
  ).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('retry-opened-selected.png') })
})
