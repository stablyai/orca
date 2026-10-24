import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const source = [
  '#!/usr/bin/env groovy',
  '// build note',
  "@Library('shared') _",
  'def greeting = "Hello ${name}"',
  'def pattern = /hello\\d+/',
  "stage('Build') { sh 'echo hello' }",
  '/* outer comment',
  'class Hidden { def value = 42 }',
  '*/ int answer = 42',
  'def script = """hello',
  'class StringBody ${name}',
  '"""; int after = 43',
  ''
].join('\n')

async function paintedTokens(editor: Locator) {
  return editor.locator('.view-lines:not(.line-delete)').evaluate((lines) =>
    [...lines.querySelectorAll('.view-line')].map((line) => ({
      text: (line.textContent ?? '').replaceAll('\u00a0', ' '),
      tokens: [...line.querySelectorAll('span[class*="mtk"]')].map((token) => ({
        text: (token.textContent ?? '').replaceAll('\u00a0', ' '),
        className: token.className,
        color: getComputedStyle(token).color
      }))
    }))
  )
}

async function expectHighlighted(editor: Locator): Promise<void> {
  await expect(editor).toBeVisible()
  await expect(editor.locator('.view-lines:not(.line-delete)')).toContainText('// build note')
  await expect
    .poll(
      async () => {
        const lines = await paintedTokens(editor)
        const color = (lineText: string, text: string) =>
          lines
            .find((line) => line.text === lineText)
            ?.tokens.find((token) => token.text.includes(text))?.color
        const keyword = color('def greeting = "Hello ${name}"', 'def')
        const comment = color('// build note', 'build note')
        const string = color('def greeting = "Hello ${name}"', 'Hello')
        const interpolation = color('def greeting = "Hello ${name}"', 'name')
        const regexp = color('def pattern = /hello\\d+/', 'hello')
        const annotation = color("@Library('shared') _", '@Library')
        const hidden = color('class Hidden { def value = 42 }', 'class')
        const resumed = color('*/ int answer = 42', '42')
        const multiline = color('class StringBody ${name}', 'class')
        return (
          [
            keyword,
            comment,
            string,
            interpolation,
            regexp,
            annotation,
            hidden,
            resumed,
            multiline
          ].every(Boolean) &&
          new Set([keyword, comment, string, interpolation]).size >= 3 &&
          hidden === comment &&
          resumed !== comment &&
          multiline === string
        )
      },
      { timeout: 25_000 }
    )
    .toBe(true)
}

test('renders groovy source and source-control diffs in both themes', async ({
  orcaPage,
  electronApp,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'groovy-highlighting')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  for (const filename of ['run', 'Build.groovy', 'Jenkinsfile.release']) {
    writeFileSync(
      path.join(fixture.worktreePath, filename),
      filename === 'run' ? source : source.slice(source.indexOf('\n') + 1)
    )
  }
  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  const identity = await electronApp.evaluate(({ BrowserWindow }) => ({
    cwd: process.cwd(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      visible: window.isVisible(),
      focused: window.isFocused()
    }))
  }))
  expect(identity.cwd).toBe(process.cwd())
  expect(identity.windows.length).toBeGreaterThan(0)
  expect(identity.windows.every((window) => !window.visible && !window.focused)).toBe(true)
  await testInfo.attach('hidden-instance-identity', {
    body: JSON.stringify(identity, null, 2),
    contentType: 'application/json'
  })

  for (const filename of ['run', 'Build.groovy', 'Jenkinsfile.release']) {
    await orcaPage.evaluate(() => window.__store?.getState().showRightSidebarFiles())
    await orcaPage
      .locator('button[data-explorer-draggable="true"]')
      .filter({ has: orcaPage.getByText(filename, { exact: true }) })
      .click()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.filePath))
      .toBe(path.join(fixture.worktreePath, filename))
    const expectedContent = filename === 'run' ? source : source.slice(source.indexOf('\n') + 1)
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength))
      .toBe(expectedContent.length)
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (filename) =>
            window.__store?.getState().openFiles.find((file) => file.relativePath === filename)
              ?.language,
          filename
        )
      )
      .toBe(filename === 'run' ? 'plaintext' : 'groovy')

    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (theme) => window.__store?.getState().updateSettings({ theme }),
        theme
      )
      const editor = orcaPage
        .locator(theme === 'light' ? '.monaco-editor.vs' : '.monaco-editor.vs-dark')
        .first()
      await expectHighlighted(editor)
      await testInfo.attach(`${filename}-source-${theme}-tokens`, {
        body: JSON.stringify(await paintedTokens(editor), null, 2),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath(`${filename}-source-${theme}.png`) })
    }

    await orcaPage.getByRole('button', { name: /Source Control/ }).click()
    await orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: filename })
      .click()
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (theme) => window.__store?.getState().updateSettings({ theme }),
        theme
      )
      const editor = orcaPage.locator(
        theme === 'light'
          ? '.modified-in-monaco-diff-editor.vs'
          : '.modified-in-monaco-diff-editor.vs-dark'
      )
      await expectHighlighted(editor)
      await testInfo.attach(`${filename}-diff-${theme}-tokens`, {
        body: JSON.stringify(await paintedTokens(editor), null, 2),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath(`${filename}-diff-${theme}.png`) })
    }
  }
  await orcaPage.getByRole('button', { name: 'View all', exact: true }).click()
  const runSection = orcaPage
    .locator('[data-combined-diff-section-row]')
    .filter({ has: orcaPage.locator('.path-display-file').filter({ hasText: /^run$/ }) })
  await runSection.scrollIntoViewIfNeeded()
  for (const theme of ['light', 'dark'] as const) {
    await orcaPage.evaluate((theme) => window.__store?.getState().updateSettings({ theme }), theme)
    const editor = runSection.locator(
      theme === 'light'
        ? '.modified-in-monaco-diff-editor.vs'
        : '.modified-in-monaco-diff-editor.vs-dark'
    )
    await expectHighlighted(editor)
    await testInfo.attach(`run-combined-${theme}-tokens`, {
      body: JSON.stringify(await paintedTokens(editor), null, 2),
      contentType: 'application/json'
    })
    await orcaPage.screenshot({ path: testInfo.outputPath(`run-combined-${theme}.png`) })
  }
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})

test.describe('folder workspace', () => {
  test.use({ seedTestRepo: false })
  test('detects an extensionless Groovy shebang when opened from folder Explorer', async ({
    orcaPage,
    electronApp,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-groovy-folder-')))
    registerPostElectronShutdownCleanup(async () =>
      rmSync(folderPath, { recursive: true, force: true })
    )
    writeFileSync(path.join(folderPath, 'run'), source)
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async (folderPath) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const group = await window.api.projectGroups.create({
        name: 'Groovy folder acceptance',
        parentPath: folderPath,
        createdFrom: 'folder-scan'
      })
      await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null, throwOnError: true })
      const folder = await store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: group.id, name: 'Groovy scripts', folderPath },
          { runtimeEnvironmentId: null }
        )
      if (!folder) {
        throw new Error('Could not create folder workspace')
      }
      store.getState().openModal('worktree-palette')
    }, folderPath)
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    await palette.getByRole('combobox').fill('Groovy scripts')
    await palette.getByRole('combobox').press('Enter')
    await expect(palette).toHaveCount(0)
    await orcaPage.evaluate(() => window.__store?.getState().showRightSidebarFiles())
    await orcaPage
      .locator('button[data-explorer-draggable="true"]')
      .filter({ has: orcaPage.getByText('run', { exact: true }) })
      .click()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.filePath))
      .toBe(path.join(folderPath, 'run'))
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () =>
            window.__store?.getState().openFiles.find((file) => file.relativePath === 'run')
              ?.language
        )
      )
      .toBe('plaintext')
    for (const theme of ['light', 'dark'] as const) {
      await orcaPage.evaluate(
        (theme) => window.__store?.getState().updateSettings({ theme }),
        theme
      )
      const editor = orcaPage
        .locator(theme === 'light' ? '.monaco-editor.vs' : '.monaco-editor.vs-dark')
        .first()
      await expectHighlighted(editor)
      await testInfo.attach(`folder-run-${theme}-tokens`, {
        body: JSON.stringify(await paintedTokens(editor), null, 2),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath(`folder-run-${theme}.png`) })
    }
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
      )
    ).toBe(true)
  })
})
