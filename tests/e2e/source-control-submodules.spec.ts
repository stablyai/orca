import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@playwright/test'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('source-control')
  })
  await expect(page.getByRole('button', { name: /Source Control/ })).toBeVisible()
}

async function openFileExplorer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('explorer')
    state?.showRightSidebarFiles()
  })
  await expect(page.getByRole('button', { name: /^Explorer/ }).first()).toBeVisible()
}

async function getActiveWorktreePath(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('active worktree is not set')
    }
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    return worktree.path
  })
}

async function refreshSourceControlStatus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    const status = await window.api.git.status({ worktreePath: worktree.path })
    state.setGitStatus(worktree.id, status)
  })
}

async function createCommittedSubmodule(
  worktreePath: string,
  submodulePath: string
): Promise<{ libraryPath: string; submodulePath: string }> {
  const libraryPath = await mkdtemp(path.join(tmpdir(), 'orca-e2e-submodule-lib-'))
  await git(libraryPath, ['init', '-q'])
  await git(libraryPath, ['config', 'user.email', 'e2e@test.local'])
  await git(libraryPath, ['config', 'user.name', 'E2E Test'])
  await writeFile(path.join(libraryPath, 'README.md'), 'submodule library\n')
  await git(libraryPath, ['add', 'README.md'])
  await git(libraryPath, ['commit', '-qm', 'init submodule library'])

  await git(worktreePath, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    libraryPath,
    submodulePath
  ])
  await git(worktreePath, ['commit', '-qm', 'add e2e submodule'])
  return { libraryPath, submodulePath }
}

test.describe('Source Control submodules', () => {
  let libraryPaths: string[] = []

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test.afterEach(async () => {
    for (const libraryPath of libraryPaths) {
      await rm(libraryPath, { recursive: true, force: true })
    }
    libraryPaths = []
  })

  test('models submodules from .gitmodules while source control shows dirty parent rows plus nested SCM sections in Electron', async ({
    orcaPage
  }) => {
    const worktreePath = await getActiveWorktreePath(orcaPage)
    const stamp = Date.now()
    const clean = await createCommittedSubmodule(worktreePath, `000-e2e-clean-submodule-${stamp}`)
    const dirty = await createCommittedSubmodule(worktreePath, `000-e2e-dirty-submodule-${stamp}`)
    libraryPaths.push(clean.libraryPath, dirty.libraryPath)
    const dirtySubmoduleWorktreePath = path.join(worktreePath, dirty.submodulePath)
    await git(dirtySubmoduleWorktreePath, ['config', 'user.email', 'e2e@test.local'])
    await git(dirtySubmoduleWorktreePath, ['config', 'user.name', 'E2E Test'])
    await writeFile(path.join(worktreePath, dirty.submodulePath, 'README.md'), 'dirty library\n')
    await writeFile(path.join(worktreePath, dirty.submodulePath, 'NOTES.md'), 'nested notes\n')

    const statusSnapshot = await orcaPage.evaluate(async (worktreePath) => {
      const status = await window.api.git.status({ worktreePath })
      return {
        entries: status.entries,
        submodules: status.submodules ?? []
      }
    }, worktreePath)
    expect(statusSnapshot.submodules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: clean.submodulePath, path: clean.submodulePath }),
        expect.objectContaining({ name: dirty.submodulePath, path: dirty.submodulePath })
      ])
    )
    expect(statusSnapshot.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: dirty.submodulePath,
          submodule: expect.objectContaining({ trackedChanges: true })
        })
      ])
    )
    expect(statusSnapshot.entries).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: clean.submodulePath })])
    )

    await refreshSourceControlStatus(orcaPage)
    await openSourceControl(orcaPage)

    await expect(orcaPage.getByText('Submodules')).toHaveCount(0)
    await expect(
      orcaPage.locator(`[data-source-control-path="${dirty.submodulePath}"]`)
    ).toBeVisible()
    await expect(
      orcaPage.locator(`[data-source-control-path="${clean.submodulePath}"]`)
    ).toHaveCount(0)
    await expect(orcaPage.getByText(`${path.basename(dirty.submodulePath)} Git`)).toBeVisible()
    const nestedReadmeRow = orcaPage.locator('[data-source-control-path="README.md"]')
    const nestedNotesRow = orcaPage.locator('[data-source-control-path="NOTES.md"]')
    await expect(nestedReadmeRow).toBeVisible()
    await expect(nestedNotesRow).toBeVisible()
    const submoduleActions = orcaPage.locator(
      `[data-source-control-submodule-actions="${dirty.submodulePath}"]`
    )
    await expect(submoduleActions).toBeVisible()
    await expect(submoduleActions.getByRole('button', { name: 'Stage All' })).toBeVisible()
    await submoduleActions.getByRole('button', { name: 'Stage All' }).click()

    await expect
      .poll(async () => {
        return orcaPage.evaluate(async (submodulePath) => {
          const status = await window.api.git.status({ worktreePath: submodulePath })
          return status.entries
            .map((entry) => [entry.path, entry.area])
            .sort(([a], [b]) => a.localeCompare(b))
        }, dirtySubmoduleWorktreePath)
      })
      .toEqual([
        ['NOTES.md', 'staged'],
        ['README.md', 'staged']
      ])

    await expect(submoduleActions.getByRole('button', { name: 'Commit' })).toBeDisabled()
    await submoduleActions.getByLabel('Submodule commit message').fill('commit nested changes')
    await expect(submoduleActions.getByRole('button', { name: 'Commit' })).toBeEnabled()
    await submoduleActions.getByRole('button', { name: 'Commit' }).click()

    await expect
      .poll(async () => {
        return orcaPage.evaluate(async (submodulePath) => {
          const status = await window.api.git.status({ worktreePath: submodulePath })
          return status.entries.length
        }, dirtySubmoduleWorktreePath)
      })
      .toBe(0)
    const { stdout: latestSubmoduleCommit } = await execFileAsync(
      'git',
      ['log', '-1', '--pretty=%s'],
      { cwd: dirtySubmoduleWorktreePath }
    )
    expect(latestSubmoduleCommit.trim()).toBe('commit nested changes')

    await openFileExplorer(orcaPage)
    const cleanExplorerRow = orcaPage.getByRole('button', {
      name: new RegExp(path.basename(clean.submodulePath))
    })
    const dirtyExplorerRow = orcaPage.getByRole('button', {
      name: new RegExp(path.basename(dirty.submodulePath))
    })
    await expect(cleanExplorerRow.getByLabel('Submodule')).toBeVisible()
    await expect(dirtyExplorerRow.getByLabel('Submodule')).toBeVisible()
  })
})
