import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'
import { test as base, expect } from './helpers/orca-app'
import { pressShortcut } from './helpers/shortcuts'
import { worktreeRow } from './worktree-row-locators'

async function git(repo: string, args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repo })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout.trim()
}

const test = base.extend({
  seededRepoPath: async ({ registerPostElectronShutdownCleanup }, provideFixture) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-retained-branch-e2e-')))
    registerPostElectronShutdownCleanup(async () => rm(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    const feature = join(root, 'feature')
    await mkdir(repo)
    await git(repo, ['init', '-q'])
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(repo, ['config', 'user.name', 'Branch Retention'])
    await git(repo, ['config', 'user.email', 'retention@example.invalid'])
    await writeFile(join(repo, 'README.md'), '# Branch retention proof\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'base'])
    await git(repo, ['init', '--bare', '-q', join(root, 'remote.git')])
    await git(repo, ['remote', 'add', 'origin', join(root, 'remote.git')])
    await git(repo, ['push', '-u', 'origin', 'main'])
    await git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    await git(repo, ['worktree', 'add', '-q', '-b', 'feature/unmerged-work', feature])
    await git(repo, ['config', 'branch.feature/unmerged-work.base', 'refs/remotes/origin/main'])
    await writeFile(join(feature, 'feature.txt'), 'Work that has been pushed, but not merged.\n')
    await git(feature, ['add', '.'])
    await git(feature, ['commit', '-qm', 'unmerged feature'])
    await git(feature, ['push', '-u', 'origin', 'feature/unmerged-work'])
    await provideFixture(repo)
  }
})

for (const theme of ['dark', 'light'] as const) {
  test(`deleting a pushed unmerged workspace keeps its branch (${theme})`, async ({
    orcaPage,
    seededRepoPath
  }, testInfo) => {
    await orcaPage.setViewportSize({ width: 1200, height: 900 })
    const id = await orcaPage.evaluate(async (theme) => {
      const state = window.__store!.getState()
      await state.updateSettingsOrThrow({ theme })
      const feature = Object.values(state.worktreesByRepo)
        .flat()
        .find(
          (worktree) => worktree.branch?.replace(/^refs\/heads\//, '') === 'feature/unmerged-work'
        )
      if (!feature) {
        throw new Error('Expected seeded feature workspace')
      }
      return feature.id
    }, theme)
    const head = await git(seededRepoPath, ['rev-parse', 'feature/unmerged-work'])
    expect(
      await git(seededRepoPath, ['rev-list', '--count', 'origin/main..feature/unmerged-work'])
    ).toBe('1')
    expect(
      await git(seededRepoPath, [
        'rev-list',
        '--count',
        'origin/feature/unmerged-work..feature/unmerged-work'
      ])
    ).toBe('0')
    const row = worktreeRow(orcaPage, id)
    await expect(row).toBeVisible()
    await row.hover()
    await pressShortcut(orcaPage, 'Backspace', { shift: true })
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete Workspace', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(orcaPage.getByText('Deleting workspace…', { exact: true })).toHaveCount(0)

    const screenshot = testInfo.outputPath(`retained-branch-${theme}.png`)
    await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach(`retained-branch-${theme}`, {
      path: screenshot,
      contentType: 'image/png'
    })
    await expect(orcaPage.getByText('Worktree deleted, branch kept', { exact: true })).toBeVisible()
    await expect(
      orcaPage.getByRole('button', { name: 'Force Delete Branch', exact: true })
    ).toBeVisible()
    expect(await git(seededRepoPath, ['rev-parse', 'feature/unmerged-work'])).toBe(head)
  })
}
