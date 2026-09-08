import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import type { AiVaultSearchResult } from '../../src/shared/ai-vault-search-types'

test.use({ seedTestRepo: false })

test('paired client search belongs to its isolated host and survives a host restart', async ({
  seedTestRepo
}, testInfo) => {
  expect(seedTestRepo).toBe(false)
  test.setTimeout(180000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let web: Awaited<ReturnType<typeof launchPairedElectronClient>> | null = null
  try {
    const home = await host.app.evaluate(({ app }) => {
      if (app.getPath('home') !== process.env.ORCA_E2E_HOME_DIR) {
        throw new Error('home isolation missing')
      }
      return app.getPath('home')
    })
    const project = path.join(home, 'folder-project')
    const dir = path.join(home, '.claude', 'projects', 'folder-project')
    mkdirSync(dir, { recursive: true })
    const id = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    const file = path.join(dir, `${id}.jsonl`)
    const row = (content: string) =>
      `${JSON.stringify({
        type: 'user',
        sessionId: id,
        cwd: project,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content }
      })}\n`
    writeFileSync(
      file,
      row('Paired search fixture') +
        Array.from({ length: 300 }, () => row('pairedneedle synthetic turn')).join('')
    )
    expect(existsSync(path.join(host.userDataDir, 'ai-vault-search', 'index.sqlite'))).toBe(false)
    await host.client.call('aiVault.configureSessionSearch', { enabled: true, historyDays: null })
    await expect
      .poll(async () => {
        const response = await host.client.call<AiVaultSearchResult>('aiVault.searchSessions', {
          query: 'pairedneedle'
        })
        return response.result.hits.map((hit) => hit.sessionId)
      })
      .toEqual([id])
    web = await launchPairedElectronClient(host.offer, testInfo, 'session-search-client')
    await web.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await web.page.getByRole('button', { name: /^Session History host:/ }).click()
    await web.page
      .getByRole('menuitemradio', { name: 'session-search-client', exact: true })
      .click()
    await web.page.getByPlaceholder('Search sessions').fill('pairedneedle')
    await expect(web.page.getByText('Paired search fixture', { exact: true })).toBeVisible()
    // Desktop paired sessions retain title/preview search; full text belongs to the host RPC.
    await expect(web.page.locator('mark')).toHaveCount(0)
    expect(existsSync(path.join(web.userDataDir, 'ai-vault-search', 'index.sqlite'))).toBe(false)
    await web.page.screenshot({ path: testInfo.outputPath('paired-search.png') })
    await expect(
      host.client.call('aiVault.searchSessions', {
        query: 'pairedneedle',
        executionHostId: 'ssh:fixture'
      })
    ).rejects.toThrow()
    await host.client.call('aiVault.configureSessionSearch', { paused: true })
    await web.dispose()
    web = null
    await host.restartServeProcess({
      betweenProcesses: () => {
        appendFileSync(file, row('restartneedle synthetic turn'))
      }
    })
    const paused = await host.client.call<AiVaultSearchResult>('aiVault.searchSessions', {
      query: 'restartneedle'
    })
    expect(paused.result.coverage.indexing?.phase).toBe('paused')
    expect(paused.result.hits).toHaveLength(0)
    await host.client.call('aiVault.configureSessionSearch', { paused: false })
    await expect
      .poll(async () => {
        const response = await host.client.call<AiVaultSearchResult>('aiVault.searchSessions', {
          query: 'restartneedle'
        })
        return response.result.hits.map((hit) => hit.sessionId)
      })
      .toEqual([id])
    await host.client.call('aiVault.configureSessionSearch', { enabled: false, clearIndex: true })
    const status = await host.client.call<{ enabled: boolean; indexSizeBytes: number | null }>(
      'aiVault.searchIndexStatus',
      {}
    )
    expect(status.result).toMatchObject({ enabled: false, indexSizeBytes: null })
    expect(existsSync(path.join(host.userDataDir, 'ai-vault-search', 'index.sqlite'))).toBe(false)
  } finally {
    await web?.dispose()
    await host.dispose()
  }
})
