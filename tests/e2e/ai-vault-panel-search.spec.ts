import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import type { AiVaultSearchResponse } from '../../src/shared/ai-vault-search-types'

test('search excerpts keep matches visible after long leading context', async ({
  electronApp,
  orcaPage,
  seededRepoPath
}, testInfo) => {
  const excerpts = [
    '…/Users/example/Documents/projects/application/apps/server/src/server.ts:534).\n\n**Codex, [[inspected with REA]]:** Version `26.1013.40934` contains three relevant…',
    `https://example.com/${'W'.repeat(80)}[[inspected with REA]] after a long URL`,
    `${'😀'.repeat(40)}x[[inspected with REA]] after Unicode context`,
    `Earlier analysis. ${'W'.repeat(15)} [[inspected with REA]] after a wide word`
  ]
  const response: AiVaultSearchResponse = {
    kind: 'results',
    hits: excerpts.map((snippet, index) => ({
      agent: 'codex',
      sessionId: `excerpt-layout-${index}`,
      title: `Search excerpt ${index + 1}`,
      cwd: seededRepoPath,
      branch: null,
      updatedAt: null,
      messageCount: 67,
      score: 1,
      source: { presence: 'present', filePath: '/synthetic/transcript.jsonl' },
      evidence: {
        role: 'assistant',
        timestamp: null,
        snippet
      }
    })),
    page: { cursor: null, hasMore: false },
    generation: 1,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 1
  }
  await electronApp.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('aiVault:searchSessions')
    ipcMain.handle('aiVault:searchSessions', () => result)
  }, response)
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    await state?.updateSettingsOrThrow({ aiVaultSearch: { enabled: true, historyDays: null } })
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('vault')
    state?.setRightSidebarWidth(400)
  })
  await orcaPage
    .getByRole('textbox', { name: 'Search sessions', exact: true })
    .fill('inspected with REA')
  const match = orcaPage.locator('mark').filter({ hasText: 'inspected with REA' })
  await expect(match).toHaveCount(excerpts.length)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  for (const appearance of [
    { theme: 'light', width: 400 },
    { theme: 'dark', width: 220 }
  ] as const) {
    await orcaPage.evaluate(async ({ theme, width }) => {
      await window.__store?.getState().updateSettingsOrThrow({ theme })
      window.__store?.getState().setRightSidebarWidth(width)
    }, appearance)
    for (const details of ['collapsed', 'expanded']) {
      await expect
        .poll(() =>
          match.evaluateAll((elements) =>
            elements.map((element) => {
              const rect = element.getBoundingClientRect()
              const container = element.closest('.line-clamp-2')?.getBoundingClientRect()
              return (
                container !== undefined &&
                rect.top >= container.top &&
                rect.bottom <= container.bottom &&
                rect.left >= container.left &&
                rect.right <= container.right
              )
            })
          )
        )
        .toEqual(excerpts.map(() => true))
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        testInfo.outputPath(`excerpt-${appearance.theme}-${details}.png`),
        Buffer.from(data, 'base64')
      )
      for (let index = 0; index < excerpts.length; index++) {
        await orcaPage.getByText(`Search excerpt ${index + 1}`, { exact: true }).click()
      }
    }
  }
  await cdp.detach()
})

test('panel consent enables real local transcript search; clearing restores history', async ({
  electronApp,
  orcaPage,
  seededRepoPath
}, testInfo) => {
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const directory = path.join(home, '.claude', 'projects', '-synthetic-pr7')
  mkdirSync(directory, { recursive: true })
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  writeFileSync(
    path.join(directory, `${sessionId}.jsonl`),
    `${[
      {
        type: 'user',
        sessionId,
        cwd: seededRepoPath,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Synthetic panel transcript' }
      },
      {
        type: 'assistant',
        sessionId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: 'The nebulariver implementation handles <script>literal text</script> safely.'
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('vault')
    state?.setRightSidebarWidth(400)
  })
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  await orcaPage.getByRole('radio', { name: 'All', exact: true }).click()
  const input = orcaPage.getByRole('textbox', { name: 'Search sessions', exact: true })
  await input.fill('nebulariver')
  await expect(orcaPage.getByText('Enable full-text search?', { exact: false })).toBeVisible()
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  async function screenshot(name: string) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = testInfo.outputPath(name)
    writeFileSync(screenshotPath, Buffer.from(data, 'base64'))
    await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
  }
  await screenshot('consent.png')
  await orcaPage.getByRole('button', { name: 'Enable', exact: true }).click()
  // Indexed searches are snapshots; enabling starts indexing independently of the panel.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          async () => (await window.api.aiVault.searchStatus('local')).filesIndexed
        ),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0)
  await orcaPage.getByRole('button', { name: 'Refresh Session History', exact: true }).click()
  await expect(orcaPage.locator('mark').filter({ hasText: 'nebulariver' })).toBeVisible()
  await expect(orcaPage.getByText('Synthetic panel transcript', { exact: true })).toBeVisible()
  await screenshot('results.png')
  await orcaPage.getByTitle('Drag to resume in a new tab', { exact: true }).click()
  await expect(orcaPage.locator('mark').filter({ hasText: 'nebulariver' })).toBeVisible()
  await orcaPage.getByTitle('Drag to resume in a new tab', { exact: true }).click()
  const title = orcaPage.getByText('Synthetic panel transcript', { exact: true })
  await expect(title).toHaveAttribute('draggable', 'true')
  const drag = await title.evaluate((element) => {
    const dataTransfer = new DataTransfer()
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    const payload = dataTransfer.getData('application/x-orca-ai-vault-session')
    element.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    return payload
  })
  expect(JSON.parse(drag)).toMatchObject({ sessionId, sessionExecutionHostId: 'local' })
  await title.click({ button: 'right' })
  await expect(
    orcaPage.getByRole('menuitem', { name: 'Copy Session ID', exact: true })
  ).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.locator('[role="menu"]')).toHaveCount(0)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettingsOrThrow({ theme: 'dark' })
    window.__store?.getState().setRightSidebarWidth(280)
  })
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await screenshot('results-dark-narrow.png')
  await title.click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(title).toHaveCount(0)
  await expect(orcaPage.locator('mark')).toHaveCount(0)
  await input.fill('nothingmatchesprseven')
  await expect(
    orcaPage.getByText('No matching sessions in the indexed history.', { exact: false })
  ).toBeVisible()
  await screenshot('empty.png')
  await input.press('Escape')
  await expect(input).toHaveValue('')
  await expect(orcaPage.getByText('Indexed history · best matches', { exact: false })).toHaveCount(
    0
  )
  await cdp.detach()
})

test('panel renders transport failure and unavailable reasons without a local fallback', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await orcaPage.evaluate(async () => {
    await window.__store
      ?.getState()
      .updateSettingsOrThrow({ aiVaultSearch: { enabled: true, historyDays: null } })
    window.__store?.getState().setRightSidebarOpen(true)
    window.__store?.getState().setRightSidebarTab('vault')
  })
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('aiVault:searchSessions')
    ipcMain.handle('aiVault:searchSessions', () => {
      throw new Error('Synthetic transport failure')
    })
  })
  const input = orcaPage.getByRole('textbox', { name: 'Search sessions', exact: true })
  await input.fill('needle')
  await expect(
    orcaPage.getByText('Could not search this computer.', { exact: false })
  ).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('failure.png') })
  for (const reason of ['disabled', 'not-ready', 'no-service'] as const) {
    await electronApp.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('aiVault:searchSessions')
      ipcMain.handle('aiVault:searchSessions', () => ({ kind: 'unavailable', reason: value }))
    }, reason)
    await orcaPage.getByRole('button', { name: 'Try again', exact: true }).click()
    const copy =
      reason === 'disabled'
        ? 'Search is disabled on this computer.'
        : reason === 'not-ready'
          ? 'The search index is not ready yet.'
          : 'Search is unavailable on this computer.'
    await expect(orcaPage.getByText(copy, { exact: false })).toBeVisible()
  }
})
