import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test as base } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const test = base.extend({
  orcaAppExtraEnv: async ({ testRepoPath }, provideEnv) => {
    const target = path.join(testRepoPath, 'linked-watch-target')
    const replacement = path.join(testRepoPath, 'linked-watch-replacement')
    const alias = path.join(testRepoPath, 'linked-watch-alias')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    // Seed before the native watcher crawls so this exercises linked-cache refresh.
    await mkdir(path.join(target, 'nested'), { recursive: true })
    await mkdir(path.join(replacement, 'nested'), { recursive: true })
    await writeFile(path.join(target, 'nested', 'old-linked.txt'), 'original')
    await writeFile(path.join(replacement, 'nested', 'replacement-linked.txt'), 'replacement')
    await symlink(target, alias, linkType)
    try {
      await provideEnv({})
    } finally {
      await rm(alias, { force: true })
      await rm(target, { recursive: true, force: true })
      await rm(replacement, { recursive: true, force: true })
    }
  }
})

test('refreshes followed directory links after target changes and retargeting', async ({
  orcaPage,
  testRepoPath
}) => {
  const target = path.join(testRepoPath, 'linked-watch-target')
  const replacement = path.join(testRepoPath, 'linked-watch-replacement')
  const alias = path.join(testRepoPath, 'linked-watch-alias')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store.getState().updateSettings({ followSymlinkedDirectories: true })
  })
  const row = (name: string) =>
    orcaPage.locator('[data-file-explorer-row]').filter({
      has: orcaPage.getByText(name, { exact: true })
    })
  await expect(row('linked-watch-alias')).toBeVisible()
  await row('linked-watch-alias').click()
  await row('nested').click()
  await expect(row('old-linked.txt')).toBeVisible()

  // Only the alias is expanded; the watcher names its unexpanded target.
  await writeFile(path.join(target, 'nested', 'fresh-linked.txt'), 'created')
  await expect(row('fresh-linked.txt')).toBeVisible()
  await rename(
    path.join(target, 'nested', 'old-linked.txt'),
    path.join(target, 'nested', 'renamed-linked.txt')
  )
  await expect(row('renamed-linked.txt')).toBeVisible()
  await expect(row('old-linked.txt')).toHaveCount(0)
  await rm(path.join(target, 'nested', 'fresh-linked.txt'))
  await expect(row('fresh-linked.txt')).toHaveCount(0)

  await row('nested').click()
  await writeFile(path.join(target, 'nested', 'collapsed-linked.txt'), 'while collapsed')
  await orcaPage.waitForTimeout(500)
  await row('nested').click()
  await expect(row('collapsed-linked.txt')).toBeVisible()

  await rm(alias)
  await symlink(replacement, alias, linkType)
  await expect(row('renamed-linked.txt')).toHaveCount(0)
  // Some hosts report delete/create and collapse the link; reopen only if needed.
  if ((await row('nested').count()) === 0) {
    await row('linked-watch-alias').click()
  }
  if ((await row('replacement-linked.txt').count()) === 0) {
    await row('nested').click()
  }
  await expect(row('replacement-linked.txt')).toBeVisible()

  await rm(replacement, { recursive: true })
  await expect(row('replacement-linked.txt')).toHaveCount(0)
  await mkdir(path.join(replacement, 'nested'), { recursive: true })
  await writeFile(path.join(replacement, 'nested', 'restored-linked.txt'), 'restored target')
  await expect(row('restored-linked.txt')).toBeVisible()
})
