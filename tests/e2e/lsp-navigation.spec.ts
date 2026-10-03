import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'
import { test as base, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const SCREENS_DIR = process.env.ORCA_E2E_LSP_SCREENS_DIR
const HOVER_DOC = 'Greets people from the LSP navigation fixture.'
const CLASS_LINE = 4

const FIXTURE_FILES: [string, string][] = [
  ['tsconfig.json', '{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022"}}\n'],
  [
    'src/greeter.ts',
    [
      '// LSP navigation fixture.',
      '',
      `/** ${HOVER_DOC} */`,
      'export class Greeter {',
      '  greet(name: string): string {',
      '    return `hi ${name}`',
      '  }',
      '}',
      ''
    ].join('\n')
  ],
  [
    'src/app.ts',
    [
      "import { Greeter } from './greeter'",
      '',
      "export const message = new Greeter().greet('orca')",
      ''
    ].join('\n')
  ]
]

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
}

const test = base.extend({
  minimumSeededWorktreeCount: 1,
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
  seededRepoPath: async ({}, provideFixture) => {
    // Why: realpath so the worktree path and server-reported URIs agree on macOS /var -> /private/var.
    const fixtureRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-lsp-nav-')))
    const repo = path.join(fixtureRoot, 'repo')
    for (const [name, content] of FIXTURE_FILES) {
      const file = path.join(repo, name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    await git(repo, ['init', '-q', '-b', 'main'])
    await git(repo, ['config', 'user.email', 'lsp-nav@example.invalid'])
    await git(repo, ['config', 'user.name', 'LSP nav'])
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-q', '-m', 'LSP fixture'])
    try {
      await provideFixture(repo)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }
})

test('TypeScript language server provides hover and go-to-definition', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  // Why: enable before opening a file; the renderer caches an open refusal for a few seconds.
  const enabled = await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)!
    return state.updateRepo(worktree.repoId, {
      languageServers: { enabled: { typescript: true } }
    })
  })
  expect(enabled).not.toBe(false)

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)!
    const separator = worktree.path.includes('\\') ? '\\' : '/'
    state.openFile({
      filePath: [worktree.path, 'src', 'app.ts'].join(separator),
      relativePath: 'src/app.ts',
      worktreeId,
      language: 'typescript',
      mode: 'edit'
    })
  })
  await expect(orcaPage.locator('.editor-header-path').first()).toContainText('app.ts', {
    timeout: 20_000
  })

  const usage = orcaPage
    .locator('.monaco-editor:visible .view-line')
    .filter({ hasText: 'new Greeter' })
    .locator('span', { hasText: /^Greeter$/ })
    .last()
  await expect(usage).toBeVisible({ timeout: 25_000 })

  // Why: the JSDoc lives only in greeter.ts on disk, which no Monaco model holds yet.
  const hover = orcaPage.locator('.monaco-hover:visible').filter({ hasText: HOVER_DOC })
  await expect
    .poll(
      async () => {
        await orcaPage.mouse.move(0, 0)
        await usage.hover()
        return hover
          .waitFor({ state: 'visible', timeout: 3_000 })
          .then(() => true)
          .catch(() => false)
      },
      { timeout: 45_000, intervals: [500] }
    )
    .toBe(true)
  await expect(hover).toContainText('new Greeter(): Greeter')
  if (SCREENS_DIR) {
    await orcaPage.screenshot({ path: path.join(SCREENS_DIR, 'lsp-e2e-hover.png') })
  }

  await orcaPage.mouse.move(0, 0)
  await usage.click()
  await orcaPage.keyboard.press('F12')

  await expect(orcaPage.locator('.editor-header-path:visible')).toContainText('greeter.ts', {
    timeout: 15_000
  })
  await expect(
    orcaPage.locator('.monaco-editor:visible .line-numbers.active-line-number')
  ).toHaveText(String(CLASS_LINE), { timeout: 10_000 })
  if (SCREENS_DIR) {
    await orcaPage.screenshot({ path: path.join(SCREENS_DIR, 'lsp-e2e-definition.png') })
  }
})
