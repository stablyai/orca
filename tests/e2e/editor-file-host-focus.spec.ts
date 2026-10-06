import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Worktree } from '../../src/shared/worktree/types'

test('keeps a local editor file on its owner while another host is selected', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = path.join(context.rootPath, `host-focus-${randomUUID()}.txt`)
  await writeFile(filePath, 'LOCAL_CONTENT', 'utf8')
  registerPostElectronShutdownCleanup(() => rm(filePath, { force: true }))

  // Controlled legacy owner records; reads and saves use the actual local filesystem.
  const fileId = await orcaPage.evaluate(
    ({ worktreeId, filePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Editor store unavailable')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((row) => row.id === worktreeId)
      const settings = state.settings
      if (!worktree || !settings) {
        throw new Error('Workspace unavailable')
      }
      const withoutOwner = <T extends Worktree>(row: T) =>
        row.id === worktreeId
          ? { ...row, hostId: undefined, runtimeOwnerEnvironmentId: undefined }
          : row
      store.setState({
        repos: state.repos.map((repo) =>
          repo.id === worktree.repoId
            ? { ...repo, connectionId: null, executionHostId: null }
            : repo
        ),
        worktreesByRepo: Object.fromEntries(
          Object.entries(state.worktreesByRepo).map(([repoId, rows]) => [
            repoId,
            rows.map(withoutOwner)
          ])
        ),
        detectedWorktreesByRepo: Object.fromEntries(
          Object.entries(state.detectedWorktreesByRepo).map(([repoId, result]) => [
            repoId,
            { ...result, worktrees: result.worktrees.map(withoutOwner) }
          ])
        ),
        settings: { ...settings, activeRuntimeEnvironmentId: null, editorAutoSave: false },
        activeWorkspaceExecutionHostId: 'runtime:focus-fixture'
      })
      return store.getState().openFile({
        filePath,
        relativePath: filePath.split(/[\\/]/).pop() ?? filePath,
        worktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
    },
    { worktreeId: context.worktreeId, filePath }
  )

  try {
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueTail), {
        timeout: 25_000
      })
      .toBe('LOCAL_CONTENT')
  } finally {
    await orcaPage.screenshot({
      path: testInfo.outputPath('opened-file.png'),
      animations: 'disabled'
    })
  }
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ fileId, worktreeId }) => {
          const state = window.__store?.getState()
          const file = state?.openFiles.find((row) => row.id === fileId)
          const tab = state?.unifiedTabsByWorktree[worktreeId]?.find(
            (row) => row.entityId === fileId
          )
          return { owner: file?.runtimeEnvironmentId, tabHost: tab?.executionHostId }
        },
        { fileId, worktreeId: context.worktreeId }
      )
    )
    .toEqual({ owner: null, tabHost: 'local' })

  await orcaPage.evaluate(() =>
    window.__store?.setState({ activeWorkspaceExecutionHostId: 'local' })
  )
  const editor = orcaPage.locator('.monaco-editor').first()
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.type('_SAVED_ON_LOCAL')
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => readFile(filePath, 'utf8')).toBe('LOCAL_CONTENT_SAVED_ON_LOCAL')
  await orcaPage.screenshot({ path: testInfo.outputPath('saved-file.png'), animations: 'disabled' })
})
