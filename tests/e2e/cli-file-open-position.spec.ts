import { execFile } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const execFileAsync = promisify(execFile)
const LINE_COUNT = 400

type CursorProbe = {
  filePath: string
  selection: { line: number; column: number } | null
  visibleLines: number[]
}

async function runFileOpenCli(userDataDir: string, args: string[]): Promise<void> {
  const repoRoot = process.cwd()
  await execFileAsync(
    process.execPath,
    [path.join(repoRoot, 'config', 'scripts', 'orca-dev.mjs'), 'file', 'open', ...args, '--json'],
    {
      cwd: repoRoot,
      env: { ...process.env, ORCA_DEV_USER_DATA_PATH: userDataDir },
      timeout: 30_000
    }
  )
}

async function readCursor(page: Page): Promise<CursorProbe | null> {
  return page.evaluate(() => {
    const probe = window.__monacoEditorE2E
    if (!probe) {
      return null
    }
    const snapshot = probe.snapshot()
    return {
      filePath: probe.filePath,
      selection: snapshot.selection
        ? {
            line: snapshot.selection.positionLineNumber,
            column: snapshot.selection.positionColumn
          }
        : null,
      visibleLines: snapshot.visibleRanges.flatMap((range) =>
        Array.from(
          { length: range.endLineNumber - range.startLineNumber + 1 },
          (_, index) => range.startLineNumber + index
        )
      )
    }
  })
}

test('orca file open --line --column puts the editor cursor there', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const worktreePath = await orcaPage.evaluate(
    (id) =>
      Object.values(window.__store?.getState().worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === id)?.path ?? '',
    worktreeId
  )
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const relativePath = `cli-open-position-${Date.now()}.ts`
  const filePath = path.join(worktreePath, relativePath)
  writeFileSync(
    filePath,
    Array.from({ length: LINE_COUNT }, (_, index) => `const line${index + 1} = ${index + 1}`).join(
      '\n'
    )
  )
  const open = ['--worktree', `id:${worktreeId}`, '--path', relativePath, '--focus']

  try {
    await runFileOpenCli(userDataDir, open)
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText(relativePath, {
      timeout: 20_000
    })
    await expect
      .poll(async () => (await readCursor(orcaPage))?.selection, { timeout: 20_000 })
      .toEqual({ line: 1, column: 1 })
    await testInfo.attach('file-open-without-line.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })

    await runFileOpenCli(userDataDir, [...open, '--line', '300', '--column', '7'])
    await expect
      .poll(async () => (await readCursor(orcaPage))?.selection, {
        timeout: 20_000,
        message: 'the cursor did not move to the requested line and column'
      })
      .toEqual({ line: 300, column: 7 })
    const cursor = await readCursor(orcaPage)
    expect(path.basename(cursor?.filePath ?? '')).toBe(relativePath)
    expect(cursor?.visibleLines).toContain(300)
    await testInfo.attach('file-open-at-line-300-column-7.png', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
  } finally {
    rmSync(filePath, { force: true })
  }
})
