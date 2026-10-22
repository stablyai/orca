import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'

const DAY_MS = 24 * 60 * 60 * 1000

function commitAs(
  cwd: string,
  author: string,
  message: string,
  file: string,
  daysAgo: number
): void {
  execFileSync('git', ['add', '--', file], { cwd, stdio: 'pipe' })
  execFileSync('git', ['commit', '-q', '-m', message, '--', file], {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.split(' ')[0].toLowerCase()}@example.com`,
      // Why: a backdated author time keeps the annotation's age stable ("3 months ago").
      GIT_AUTHOR_DATE: new Date(Date.now() - daysAgo * DAY_MS).toISOString()
    }
  })
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // Why: menu and hover fade-ins run slowly under Xvfb; capture after finite animations settle.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getTiming().iterations === Number.POSITIVE_INFINITY
      )
  )
  await testInfo.attach(name, {
    body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    contentType: 'image/png'
  })
}

test('Git Blame shows who last changed the cursor line', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const context = await getActiveWorktreeContext(orcaPage)
  const relativePath = path.join('blame-demo', `greeting-${testInfo.workerIndex}.ts`)
  const filePath = path.join(context.rootPath, relativePath)
  const originalHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: context.rootPath,
    encoding: 'utf8'
  }).trim()
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(
    filePath,
    "export function greet(): string {\n  return 'Hello'\n}\n\nexport const DEFAULT_NAME = 'world'\n"
  )
  commitAs(context.rootPath, 'Alice Example', 'Add greet helper', relativePath, 95)
  await writeFile(
    filePath,
    "export function greet(name: string): string {\n  return `Hello, ${name}`\n}\n\nexport const DEFAULT_NAME = 'world'\n"
  )
  commitAs(context.rootPath, 'Bob Example', 'Greet by name', relativePath, 12)

  try {
    await orcaPage.evaluate(
      ({ filePath, relativePath, worktreeId }) => {
        window.__store!.getState().openFile({
          filePath,
          relativePath,
          worktreeId,
          language: 'typescript',
          mode: 'edit'
        })
      },
      { filePath, relativePath, worktreeId: context.worktreeId }
    )
    const editor = orcaPage.locator('.monaco-editor').first()
    await expect(editor.locator('.view-line').first()).toContainText('export function greet', {
      timeout: 20_000
    })
    const annotation = orcaPage.locator('.orca-git-blame-inline')
    await expect(annotation).toHaveCount(0)
    await attachScreenshot(orcaPage, testInfo, '1-blame-off')

    await orcaPage.getByRole('button', { name: 'File actions' }).click()
    const toggle = orcaPage.getByRole('menuitemcheckbox', { name: 'Git Blame' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await attachScreenshot(orcaPage, testInfo, '2-menu-toggle')
    await toggle.click()

    await editor.locator('.view-line').nth(2).click()
    await expect(annotation).toHaveText('Alice Example, 3 months ago • Add greet helper', {
      timeout: 15_000
    })
    await editor.locator('.view-line').nth(1).click()
    await expect(annotation).toHaveText('Bob Example, 12 days ago • Greet by name')
    await attachScreenshot(orcaPage, testInfo, '3-blame-cursor-line')

    const box = await annotation.boundingBox()
    expect(box).not.toBeNull()
    await orcaPage.mouse.move(box!.x + box!.width - 8, box!.y + box!.height / 2)
    await expect(
      orcaPage.locator('.monaco-hover-content').filter({ hasText: 'bob@example.com' }).first()
    ).toBeVisible({ timeout: 10_000 })
    await attachScreenshot(orcaPage, testInfo, '4-blame-hover')
    await orcaPage.mouse.move(0, 0)

    // Unsaved edit: the buffer is re-blamed through stdin, so the new line reads as uncommitted.
    await orcaPage.keyboard.press('End')
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.type('// draft')
    await expect(annotation).toHaveText('You • Uncommitted changes', { timeout: 15_000 })
    await attachScreenshot(orcaPage, testInfo, '5-blame-unsaved-line')
  } finally {
    await rm(path.join(context.rootPath, 'blame-demo'), { recursive: true, force: true })
    execFileSync('git', ['reset', '-q', '--hard', originalHead], {
      cwd: context.rootPath,
      stdio: 'pipe'
    })
  }
})
