import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('consent, Unicode search, scope exclusion, and clear stay inside an isolated home', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const paths = await electronApp.evaluate(({ app }) => ({
    home: app.getPath('home'),
    profile: app.getPath('userData'),
    isolated: process.env.ORCA_E2E_HOME_DIR
  }))
  expect(paths.home).toBe(paths.isolated)
  const project = path.join(paths.home, 'fixture-project')
  const transcripts = path.join(paths.home, '.claude', 'projects', 'fixture-project')
  mkdirSync(transcripts, { recursive: true })
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const rows = [
    'Search audit fixture',
    '안녕하세요 coalesces transcriptneedle',
    'coalesces again'
  ].map((content, i) =>
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: project,
      timestamp: new Date(Date.now() + i).toISOString(),
      message: { role: 'user', content }
    })
  )
  writeFileSync(path.join(transcripts, `${id}.jsonl`), `${rows.join('\n')}\n`)
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  await orcaPage.evaluate(() => window.api.aiVault.listSessions({ force: true }))
  await orcaPage.getByRole('button', { name: 'Refresh Session History' }).click()
  await expect(orcaPage.getByText('Search inside conversations', { exact: true })).toBeVisible()
  const before = await orcaPage.evaluate(() => window.api.aiVault.searchIndexSize())
  expect(before.bytes).toBeNull()
  await orcaPage.getByRole('button', { name: 'Enable', exact: true }).click()
  const query = orcaPage.getByPlaceholder('Search sessions')
  await query.fill('안녕하세요')
  await expect(orcaPage.getByText('Search audit fixture', { exact: true })).toBeVisible()
  await expect(orcaPage.locator('mark')).toContainText('안녕하세요')
  await query.fill('transcriptneedle repo:missing-project')
  await expect(orcaPage.getByText('Search audit fixture', { exact: true })).toHaveCount(0)
  await query.fill('coalescs')
  await query.press('Enter')
  await expect(orcaPage.getByText(/Showing results for coalesces/)).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('session-search.png') })
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setSettingsSearchQuery('Agent Session History')
    state.openSettingsPage()
  })
  await expect(orcaPage.getByPlaceholder('Search settings')).toBeVisible()
  await orcaPage.getByRole('button', { name: /^Agent Session History\b/ }).click()
  const toggle = orcaPage.getByRole('switch', { name: 'Search inside conversations' })
  await expect(toggle).toBeChecked()
  const indexing = orcaPage.getByTestId('session-search-indexing-panel')
  await expect(indexing.getByText('Up to date', { exact: true })).toBeVisible()
  await indexing.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(indexing.getByText('Indexing paused', { exact: true })).toBeVisible()
  // The status-bar segment is read-only; it names the resting phase and opens the settings pane.
  const segment = orcaPage.getByRole('button', { name: /^Indexing paused/ })
  await expect(segment).toBeVisible()
  appendFileSync(
    path.join(transcripts, `${id}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: project,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'pausedappendneedle' }
    })}\n`
  )
  await orcaPage.evaluate(() => window.api.aiVault.listSessions({ force: true }))
  const pausedSearch = await orcaPage.evaluate(async () => ({
    saved: (await window.api.aiVault.searchSessions({ query: 'transcriptneedle' })).hits.length,
    appended: (await window.api.aiVault.searchSessions({ query: 'pausedappendneedle' })).hits.length
  }))
  expect(pausedSearch).toEqual({ saved: 1, appended: 0 })
  await orcaPage.screenshot({ path: testInfo.outputPath('session-search-indexing-paused.png') })
  await segment.click()
  await expect(orcaPage.getByPlaceholder('Search settings')).toHaveValue('Agent Session History')
  await expect(indexing.getByText('Indexing paused', { exact: true })).toBeVisible()
  await indexing.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(indexing.getByText('Up to date', { exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: /^Indexing paused/ })).toHaveCount(0)
  await expect
    .poll(
      async () =>
        (
          await orcaPage.evaluate(() =>
            window.api.aiVault.searchSessions({ query: 'pausedappendneedle' })
          )
        ).hits.length
    )
    .toBe(1)
  await toggle.click()
  await expect
    .poll(async () => (await orcaPage.evaluate(() => window.api.aiVault.searchCoverage())).enabled)
    .toBe(false)
  await orcaPage.getByRole('button', { name: 'Clear index', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Clear index', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(async () => (await orcaPage.evaluate(() => window.api.aiVault.searchIndexSize())).bytes)
    .toBeNull()
  await orcaPage.screenshot({ path: testInfo.outputPath('session-search-cleared.png') })
})
