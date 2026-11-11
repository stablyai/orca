import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { switchToWorktree, waitForSessionReady } from './helpers/store'
import { openFileExplorer } from './helpers/file-explorer'
import { quotePosixShell } from '../../src/shared/shell/launch/shell-argument-quoting'

// A per-workspace environment recipe that hands Orca an Orca server: files opened in the
// recipe-created workspace must save back to that server (#11762).
test.skip(process.platform === 'win32', 'The recipe scripts are POSIX shell')
test.use({ seedTestRepo: false })

test('saves an edited file in a recipe-created Orca server workspace', async ({ orcaPage }) => {
  // Boots a second Orca as the environment's server, then restarts it mid-test.
  test.setTimeout(300_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  const sourceRepo = mkdtempSync(path.join(tmpdir(), 'orca-recipe-server-source-'))
  const vmRoot = mkdtempSync(path.join(tmpdir(), 'orca-recipe-server-vm-'))
  try {
    seedGitRepo(vmRoot, { 'notes.txt': 'VM notes' })
    seedRecipeRepo(sourceRepo, host.offer.pairingUrl, vmRoot)
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async (repoPath) => {
      const result = await window.api.repos.add({ path: repoPath })
      if ('error' in result) {
        throw new Error(result.error)
      }
      const store = window.__store!
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
      await store.getState().updateSettings({ experimentalEphemeralVms: true })
      store.getState().setActiveRepo(result.repo.id)
    }, sourceRepo)

    await openSidebarWorkspaceComposer(orcaPage)
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('combobox', { name: 'Run on' }).click()
    await orcaPage.getByRole('option', { name: /Per-Workspace Environment/ }).click()
    await orcaPage
      .getByRole('listbox', { name: 'Per-Workspace Environment' })
      .getByText('Local Orca server', { exact: true })
      .click()
    const workspaceName = `recipe-save-${Date.now()}`
    await dialog.getByPlaceholder(/Type a name/i).fill(workspaceName)
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    const trustDialog = orcaPage.getByRole('dialog', { name: /Run VM recipe/ })
    await expect(trustDialog).toBeVisible()
    await trustDialog.getByRole('button', { name: 'Run hooks' }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })

    const findWorkspace = () =>
      orcaPage.evaluate(
        ({ name, sourceRepoPath }) => {
          const state = window.__store!.getState()
          const sourceRepoIds = new Set(
            state.repos.filter((repo) => repo.path === sourceRepoPath).map((repo) => repo.id)
          )
          return (
            Object.values(state.worktreesByRepo)
              .flat()
              .find(
                (worktree) =>
                  worktree.displayName === name &&
                  !sourceRepoIds.has(worktree.repoId) &&
                  Boolean(worktree.hostId?.startsWith('runtime:'))
              ) ?? null
          )
        },
        { name: workspaceName, sourceRepoPath: sourceRepo }
      )
    await expect.poll(findWorkspace, { timeout: 120_000 }).not.toBeNull()
    const workspace = (await findWorkspace())!
    await switchToWorktree(orcaPage, workspace.id)

    await openFileExplorer(orcaPage)
    const notesRow = orcaPage
      .locator('[data-orca-explorer-shell] [data-file-explorer-row]')
      .filter({ has: orcaPage.getByText('notes.txt', { exact: true }) })
    await expect(notesRow).toBeVisible({ timeout: 30_000 })
    await notesRow.click()
    // The workspace lives on the server, so its model has a host-keyed URI rather than file:.
    const editor = orcaPage
      .locator('.monaco-editor[data-uri^="vscode-remote:"]')
      .filter({ visible: true })
    const editorText = editor.locator('.view-lines')
    await expect(editorText).toHaveText('VM notes', { timeout: 30_000 })
    const savedPath = path.join(workspace.path, 'notes.txt')

    const replaceText = async (text: string): Promise<void> => {
      await editor.click()
      await orcaPage.keyboard.press('ControlOrMeta+A')
      await orcaPage.keyboard.type(text)
      await expect(editorText).toHaveText(text)
    }
    const waitForCleanTab = () =>
      expect
        .poll(
          () =>
            orcaPage.evaluate(
              () =>
                window
                  .__store!.getState()
                  .openFiles.find((file) => file.relativePath === 'notes.txt')?.isDirty ?? null
            ),
          { timeout: 15_000 }
        )
        .toBe(false)

    const sentinel = `Saved from recipe workspace ${Date.now()}`
    await replaceText(sentinel)
    await orcaPage.keyboard.press('ControlOrMeta+S')
    await expect.poll(() => readFileSync(savedPath, 'utf8'), { timeout: 15_000 }).toBe(sentinel)
    // The save round trip must finish before the server goes away.
    await waitForCleanTab()

    // A VM that sleeps and wakes restarts its server. The tab opened before must still save
    // there once the app reconnects on its own. Retried saves tolerate the reconnect window;
    // a tab whose owner can no longer be verified never saves (#11762).
    await host.restartServeProcess()
    const afterWake = `Saved after wake ${Date.now()}`
    await replaceText(afterWake)
    await expect(async () => {
      await orcaPage.keyboard.press('ControlOrMeta+S')
      await expect.poll(() => readFileSync(savedPath, 'utf8'), { timeout: 3_000 }).toBe(afterWake)
    }).toPass({ timeout: 60_000 })
    await waitForCleanTab()
  } finally {
    await host.dispose().catch(() => undefined)
    rmSync(sourceRepo, { recursive: true, force: true })
    rmSync(vmRoot, { recursive: true, force: true })
  }
})

function seedGitRepo(repoPath: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(repoPath, name), content)
  }
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Orca E2E'], { cwd: repoPath })
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoPath })
}

function seedRecipeRepo(repoPath: string, pairingUrl: string, vmRoot: string): void {
  const createScript = path.join(repoPath, 'create.sh')
  writeFileSync(
    createScript,
    `#!/usr/bin/env bash
set -euo pipefail
node -e 'console.log(JSON.stringify({schemaVersion:1,connection:{type:"orca-server",pairingCode:process.argv[1],projectRoot:process.argv[2]}}))' ${quotePosixShell(pairingUrl)} ${quotePosixShell(vmRoot)}
`
  )
  const destroyScript = path.join(repoPath, 'destroy.sh')
  writeFileSync(destroyScript, '#!/usr/bin/env bash\ncat >/dev/null\n')
  chmodSync(createScript, 0o755)
  chmodSync(destroyScript, 0o755)
  writeFileSync(
    path.join(repoPath, 'orca.yaml'),
    `environmentRecipes:
  - id: local-orca-server
    name: Local Orca server
    create: ./create.sh
    destroy: ./destroy.sh
`
  )
  seedGitRepo(repoPath, {})
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/stablyai/orca.git'], {
    cwd: repoPath
  })
}
