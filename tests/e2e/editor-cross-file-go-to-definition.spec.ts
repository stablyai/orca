/**
 * E2E coverage for cross-file "Go to Definition" (#5247): Cmd/Ctrl+Click and
 * F12 must both jump to a symbol's definition in a different file, not only
 * within the currently open Monaco model.
 */
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import {
  createGoldenWorktree,
  cleanupGoldenWorktree,
  activateGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

const DEFINITION_B_CONTENT =
  "import { crossFileGreeting } from './definition-a'\n\nconst message = crossFileGreeting('e2e')\n"

function positionOfOffset(content: string, offset: number): { lineNumber: number; column: number } {
  const before = content.slice(0, offset)
  const lines = before.split('\n')
  return { lineNumber: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

// Position inside the call-site occurrence of `crossFileGreeting` (not the import specifier).
const CALL_POSITION = positionOfOffset(
  DEFINITION_B_CONTENT,
  DEFINITION_B_CONTENT.lastIndexOf('crossFileGreeting') + 1
)

function seedCrossFileProject(worktreePath: string): void {
  const srcDir = path.join(worktreePath, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(
    path.join(worktreePath, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'commonjs', moduleResolution: 'node' },
      include: ['src/**/*.ts']
    })
  )
  writeFileSync(
    path.join(srcDir, 'definition-a.ts'),
    'export function crossFileGreeting(name: string): string {\n  return `hi ${name}`\n}\n'
  )
  writeFileSync(path.join(srcDir, 'definition-b.ts'), DEFINITION_B_CONTENT)
}

async function openDefinitionB(
  page: Parameters<typeof waitForActiveWorktree>[0],
  worktreeId: string,
  worktreePath: string
): Promise<void> {
  await page.evaluate(
    ({ worktreeId, filePath }) => {
      window.__store?.getState().openFile({
        filePath,
        relativePath: 'src/definition-b.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      })
    },
    { worktreeId, filePath: path.join(worktreePath, 'src', 'definition-b.ts') }
  )
}

async function getCallSiteClientPoint(
  page: Parameters<typeof waitForActiveWorktree>[0]
): Promise<{ x: number; y: number }> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (position) => window.__monacoEditorE2E?.getClientPointForPosition(position) ?? null,
          CALL_POSITION
        ),
      { message: 'Monaco did not report a client point for the call site', timeout: 15_000 }
    )
    .not.toBeNull()
  const point = await page.evaluate(
    (position) => window.__monacoEditorE2E?.getClientPointForPosition(position) ?? null,
    CALL_POSITION
  )
  if (!point) {
    throw new Error('Could not resolve a client point for the call site')
  }
  return point
}

test('Cmd/Ctrl+Click and F12 both jump to a definition in another file', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'cross-file-definition')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedCrossFileProject(fixture.worktreePath)

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  await openDefinitionB(orcaPage, worktreeId, fixture.worktreePath)
  await expect(orcaPage.locator('.monaco-editor').first()).toBeVisible({ timeout: 25_000 })
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('definition-b.ts', {
    timeout: 20_000
  })

  const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
  const modifier = isMac ? 'Meta' : 'Control'
  const clickPoint = await getCallSiteClientPoint(orcaPage)
  await orcaPage.mouse.move(clickPoint.x, clickPoint.y)
  await orcaPage.keyboard.down(modifier)
  await orcaPage.mouse.down()
  await orcaPage.mouse.up()
  await orcaPage.keyboard.up(modifier)
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('definition-a.ts', {
    timeout: 20_000
  })

  // Re-open definition-b.ts and exercise F12 from a plain (unmodified) click at the same call site.
  await openDefinitionB(orcaPage, worktreeId, fixture.worktreePath)
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('definition-b.ts', {
    timeout: 20_000
  })
  const plainClickPoint = await getCallSiteClientPoint(orcaPage)
  await orcaPage.mouse.click(plainClickPoint.x, plainClickPoint.y)
  await orcaPage.keyboard.press('F12')

  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('definition-a.ts', {
    timeout: 20_000
  })
})
