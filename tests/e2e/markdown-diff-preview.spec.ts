import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('renders the modified markdown side from the diff toolbar Preview toggle', async ({
  orcaPage,
  testRepoPath
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const relativePath = 'README.md'
  const filePath = path.join(testRepoPath, relativePath)
  const originalContent = readFileSync(filePath, 'utf8')
  const heading = `Markdown diff preview ${Date.now()}`

  try {
    writeFileSync(filePath, `# ${heading}\n\nRendered from the modified diff side.\n`)

    await orcaPage.evaluate(
      ({ worktreeId: targetWorktreeId, targetFilePath, targetRelativePath }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        store
          .getState()
          .openDiff(targetWorktreeId, targetFilePath, targetRelativePath, 'markdown', false)
      },
      { worktreeId, targetFilePath: filePath, targetRelativePath: relativePath }
    )

    await expect(orcaPage.locator('.editor-header-path')).toContainText(relativePath, {
      timeout: 20_000
    })
    const previewToggle = orcaPage.locator('button[aria-label="Preview"]')
    await expect(previewToggle).toBeVisible({ timeout: 20_000 })
    await previewToggle.click()

    await expect(orcaPage.getByRole('heading', { name: heading, level: 1 })).toBeVisible({
      timeout: 20_000
    })
    await expect(
      orcaPage.getByText('Previewing the modified version of this diff', { exact: false })
    ).toBeVisible()
  } finally {
    writeFileSync(filePath, originalContent)
  }
})
